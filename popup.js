const ALLOWED_HOSTS = ["lms.sevenenglish.net"];

const toggleButton = document.getElementById("toggle");
const skipStepButton = document.getElementById("skipStep");
const statusText = document.getElementById("status");
const typingSpeedInput = document.getElementById("typingSpeed");
const solveModeSelect = document.getElementById("solveMode");
const skipVoca2Checkbox = document.getElementById("skipVoca2");
const notifyCheckbox = document.getElementById("notifyOnComplete");
const advancedDebugCheckbox = document.getElementById("advancedDebug");

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["typingSpeed", "solveMode", "skipVoca2", "notifyOnComplete", "advancedDebug"], (result) => {
    if (result.typingSpeed) typingSpeedInput.value = result.typingSpeed;
    if (result.solveMode) solveModeSelect.value = result.solveMode;
    if (skipVoca2Checkbox && result.skipVoca2 !== undefined) skipVoca2Checkbox.checked = result.skipVoca2;
    if (result.notifyOnComplete !== undefined) notifyCheckbox.checked = result.notifyOnComplete;
    if (result.advancedDebug !== undefined) advancedDebugCheckbox.checked = result.advancedDebug;
  });
});

[typingSpeedInput, solveModeSelect, skipVoca2Checkbox, notifyCheckbox, advancedDebugCheckbox].forEach(el => {
  if (!el) return;
  el.addEventListener("change", () => {
    chrome.storage.local.set({
      typingSpeed: typingSpeedInput.value,
      solveMode: solveModeSelect.value,
      skipVoca2: skipVoca2Checkbox ? skipVoca2Checkbox.checked : true,
      notifyOnComplete: notifyCheckbox.checked,
      advancedDebug: advancedDebugCheckbox.checked
    });
  });
});

function runToggle(allowedHosts, mode, settings) {
  if (!allowedHosts.includes(location.hostname)) {
    return { error: "허용된 호스트가 아닙니다: " + location.hostname };
  }

  const old = window.__DebugTester;

  if (mode === "status") return { active: !!(old && old.active) };

  if (old && old.active) {
    old.stop();
    return { active: false };
  }

  const tester = {
    active: true,
    timer: null,
    actionTimer: null,
    lastQuestion: "",
    busy: false,
    settings: settings || { typingSpeed: 60, solveMode: "all", skipVoca2: true, notify: true, debug: true },

    stop() {
      this.active = false;
      clearInterval(this.timer);
      clearTimeout(this.actionTimer);
      this.timer = this.actionTimer = null;
      this.busy = false;
    },

    getRoot() {
      const pages = document.querySelectorAll(".outer-wrapper[page-name]");
      for (const p of pages) {
        if (p.getClientRects().length && getComputedStyle(p).display !== "none") return p;
      }
      return null;
    },

    solveStep() {
      if (this.busy || !this.active) return;

      const root = this.getRoot();
      if (!root) return;

      const pageName = (root.getAttribute("page-name") || "").toLowerCase();

      if (pageName.includes("result")) {
        if (this.settings.notify && !window.__studyCompletedNotified) {
          window.__studyCompletedNotified = true;
          chrome.runtime.sendMessage({ type: "STUDY_COMPLETED" });
        }
        return;
      }

      if (this.settings.skipVoca2 && (pageName.includes("voca2") || pageName.includes("intro") || root.querySelector("#_popup_voca2_start"))) {
        this.busy = true;
        
        const startPop = document.querySelector("#_popup_voca2_start");
        if (startPop) {
          const btn = startPop.querySelector("div.pop01_bottom > div, button, a");
          if (btn) btn.click();
          startPop.style.display = "none";
        }

        const skipBtn = root.querySelector(".btn-skip, .skip-btn, button.skip, .skip");
        if (skipBtn) skipBtn.click();

        try {
          if (typeof controller !== "undefined" && typeof controller.setNext === "function") {
            controller.setNext();
          } else if (typeof playerData !== "undefined" && playerData.step && typeof playerData.step.getNext === "function") {
            const nextStep = playerData.step.getNext();
            if (nextStep && nextStep.stepCode) {
              playerData.setCurrentStep(nextStep.stepCode);
              if (typeof pageLoad === "function") pageLoad(nextStep.stepCode);
            }
          }
        } catch (e) {}

        this.actionTimer = setTimeout(() => { this.busy = false; }, 400);
        return;
      }

      const qCountNode = root.querySelector("div.title-bar > span.q-count, .q-count");
      const qLimitNode = root.querySelector("div.title-bar > span.q-count-limit, .q-count-limit");
      let progressStr = "";
      if (qCountNode && qLimitNode) {
        progressStr = ` (${qCountNode.textContent.trim()}/${qLimitNode.textContent.trim()})`;
      }

      const qNode = root.querySelector("div.middle_sentence > p, .question-text, .step_question p, .word_question, .sentence_question");
      if (!qNode) return;

      const currentQuestion = (qNode.textContent || "").trim();
      if (!currentQuestion || currentQuestion === this.lastQuestion) return;

      let pData;
      try { pData = window.playerData; } catch (e) { pData = null; }
      if (!pData || !Array.isArray(pData.objectList)) return;

      let currentObj = pData.objectList.find(obj => {
        if (!obj) return false;
        const eng = String(obj.vocaEng || "").trim();
        const han = String(obj.vocaHan || "").trim();
        return eng === currentQuestion || han === currentQuestion || currentQuestion.includes(eng) || currentQuestion.includes(han);
      });

      if (!currentObj) return;

      const isQuestionHan = (currentQuestion === String(currentObj.vocaHan || "").trim() || currentQuestion.includes(String(currentObj.vocaHan || "").trim()));
      const targetAnswer = isQuestionHan ? String(currentObj.vocaEng || "").trim() : String(currentObj.vocaHan || "").trim();

      const inputField = root.querySelector("input[type='text'], input:not([type]), .input_box input, textarea");
      if (inputField && this.settings.solveMode !== "choice") {
        this.busy = true;
        this.lastQuestion = currentQuestion;

        inputField.focus();
        inputField.value = "";
        inputField.dispatchEvent(new Event("focus", { bubbles: true }));

        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set ||
                               Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

        let charIndex = 0;
        const speed = parseInt(this.settings.typingSpeed) || 60;

        const typeNextChar = () => {
          if (!inputField.isConnected) {
            this.busy = false;
            return;
          }

          if (charIndex < targetAnswer.length) {
            const ch = targetAnswer[charIndex++];
            const code = ch.charCodeAt(0);

            const keyOpts = { key: ch, code: `Key${ch.toUpperCase()}`, bubbles: true, cancelable: true, keyCode: code, which: code };
            
            inputField.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
            inputField.dispatchEvent(new KeyboardEvent("keypress", keyOpts));

            const currentVal = inputField.value + ch;
            if (nativeSetter) nativeSetter.call(inputField, currentVal);
            else inputField.value = currentVal;

            inputField.dispatchEvent(new Event("input", { bubbles: true }));
            inputField.dispatchEvent(new KeyboardEvent("keyup", keyOpts));

            this.actionTimer = setTimeout(typeNextChar, speed);
          } else {
            inputField.dispatchEvent(new Event("change", { bubbles: true }));

            this.actionTimer = setTimeout(() => {
              const enterEvent = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, keyCode: 13, which: 13 });
              inputField.dispatchEvent(enterEvent);
              inputField.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, keyCode: 13, which: 13 }));

              const submitBtn = root.querySelector(".btn-submit, .btn_next, button.submit, button.ok, .btn_confirm");
              if (submitBtn) submitBtn.click();

              setTimeout(() => { this.busy = false; }, 300);
            }, 100);
          }
        };

        typeNextChar();
        return;
      }

      const choiceButtons = root.querySelectorAll(".example-wrapper > div, .example-wrapper button, button.btn-example, .choice-btn");
      if (choiceButtons.length > 0 && this.settings.solveMode !== "typing") {
        let targetButton = null;
        for (const btn of choiceButtons) {
          const btnText = (btn.textContent || "").trim();
          if (btnText === targetAnswer || btnText.includes(targetAnswer)) {
            targetButton = btn;
            break;
          }
        }

        if (targetButton) {
          if (targetButton.classList.contains("voca-answer-correct")) return;

          this.busy = true;
          this.lastQuestion = currentQuestion;

          targetButton.click();

          this.actionTimer = setTimeout(() => {
            this.busy = false;
          }, 400);
        }
      }
    },

    start() {
      window.__studyCompletedNotified = false;
      this.timer = setInterval(() => {
        try {
          this.solveStep();
        } catch (e) {}
      }, 250);
    }
  };

  window.__DebugTester = tester;
  tester.start();
  return { active: true };
}

function render(active) {
  toggleButton.textContent = active ? "자동 풀이 중지" : "자동 풀이 시작";
  toggleButton.classList.toggle("stop", active);
  statusText.textContent = active ? "자동 풀이 작동 중..." : "자동 풀이가 중지되었습니다.";
}

async function exec(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("활성 탭을 찾을 수 없습니다.");

  const settings = await new Promise((resolve) => {
    chrome.storage.local.get(["typingSpeed", "solveMode", "skipVoca2", "notifyOnComplete", "advancedDebug"], (res) => {
      resolve({
        typingSpeed: res.typingSpeed || 60,
        solveMode: res.solveMode || "all",
        skipVoca2: res.skipVoca2 !== false,
        notify: res.notifyOnComplete !== false,
        debug: res.advancedDebug !== false
      });
    });
  });

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: runToggle,
    args: [ALLOWED_HOSTS, mode, settings]
  });

  const state = result?.[0]?.result;
  if (state?.error) throw new Error(state.error);
  return !!state?.active;
}

toggleButton.addEventListener("click", async () => {
  toggleButton.disabled = true;
  try {
    render(await exec("toggle"));
  } catch (e) {
    statusText.textContent = e.message || "실행할 수 없습니다.";
  } finally {
    toggleButton.disabled = false;
  }
});

// 현재 단계 즉시 건너뛰기 버튼 이벤트
skipStepButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: () => {
      try {
        if (typeof controller !== "undefined" && typeof controller.setNext === "function") {
          controller.setNext();
        } else if (typeof playerData !== "undefined" && playerData.step && typeof playerData.step.getNext === "function") {
          const nextStep = playerData.step.getNext();
          if (nextStep && nextStep.stepCode) {
            playerData.setCurrentStep(nextStep.stepCode);
            if (typeof pageLoad === "function") pageLoad(nextStep.stepCode);
          }
        }
      } catch (e) {}
    }
  });
});

exec("status").then(render).catch(e => {
  statusText.textContent = "학습 페이지에서만 작동합니다.";
});