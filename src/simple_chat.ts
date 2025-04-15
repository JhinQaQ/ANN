import appConfig from "./app-config";
import * as webllm from "@mlc-ai/web-llm";

function getElementAndCheck(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element == null) {
    throw Error("Cannot find element " + id);
  }
  return element;
}

class ChatUI {
  private uiChat: HTMLElement;
  private uiChatInput: HTMLTextAreaElement;
  private uiChatInfoLabel: HTMLLabelElement;
  private engine: webllm.MLCEngineInterface | webllm.WebWorkerMLCEngine;
  private config: webllm.AppConfig = appConfig;
  private selectedModel: string;
  private chatLoaded = false;
  private requestInProgress = false;
  private chatHistory: webllm.ChatCompletionMessageParam[] = [];
  // We use a request chain to ensure that
  // all requests send to chat are sequentialized
  private chatRequestChain: Promise<void> = Promise.resolve();

  /**
   * An asynchronous factory constructor since we need to await getMaxStorageBufferBindingSize();
   * this is not allowed in a constructor (which cannot be asynchronous).
   */
  public static CreateAsync = async (engine: webllm.MLCEngineInterface) => {
    const chatUI = new ChatUI();
    chatUI.engine = engine;
    // get the elements
    chatUI.uiChat = getElementAndCheck("chatui-chat");
    chatUI.uiChatInput = getElementAndCheck("chatui-input") as HTMLTextAreaElement;
    chatUI.uiChatInfoLabel = getElementAndCheck(
      "chatui-info-label",
    ) as HTMLLabelElement;
    
    // register event handlers
    getElementAndCheck("chatui-reset-btn").onclick = () => {
      chatUI.onReset();
    };
    getElementAndCheck("chatui-send-btn").onclick = () => {
      chatUI.onGenerate();
    };
    
    // Auto-resize textarea as user types
    chatUI.uiChatInput.addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = (this.scrollHeight) + "px";
    });
    
    // Handle Enter key to send message (Shift+Enter for new line)
    chatUI.uiChatInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatUI.onGenerate();
      }
    });

    // When we detect low maxStorageBufferBindingSize, we assume that the device (e.g. an Android
    // phone) can only handle small models and make all other models unselectable. Otherwise, the
    // browser may crash. See https://github.com/mlc-ai/web-llm/issues/209.
    // Also use GPU vendor to decide whether it is a mobile device (hence with limited resources).
    const androidMaxStorageBufferBindingSize = 1 << 27; // 128MB
    const mobileVendors = new Set<string>(["qualcomm", "arm"]);
    let restrictModels = false;
    let maxStorageBufferBindingSize: number;
    let gpuVendor: string;
    try {
      [maxStorageBufferBindingSize, gpuVendor] = await Promise.all([
        engine.getMaxStorageBufferBindingSize(),
        engine.getGPUVendor(),
      ]);
    } catch (err) {
      chatUI.appendMessage("error", "Init error, " + err.toString());
      console.log(err.stack);
      return;
    }
    if (
      (gpuVendor.length != 0 && mobileVendors.has(gpuVendor)) ||
      maxStorageBufferBindingSize <= androidMaxStorageBufferBindingSize
    ) {
      chatUI.appendMessage(
        "init",
        "Your device seems to have " +
          "limited resources, so we restrict the selectable models.",
      );
      restrictModels = true;
    }

    // Populate modelSelector
    const modelSelector = getElementAndCheck(
      "chatui-select",
    ) as HTMLSelectElement;
    for (let i = 0; i < chatUI.config.model_list.length; ++i) {
      const item = chatUI.config.model_list[i];
      const opt = document.createElement("option");
      opt.value = item.model_id;
      opt.innerHTML = item.model_id;
      opt.selected = i == 0;
      if (
        (restrictModels &&
          (item.low_resource_required === undefined ||
            !item.low_resource_required)) ||
        (item.buffer_size_required_bytes &&
          maxStorageBufferBindingSize < item.buffer_size_required_bytes)
      ) {
        // Either on a low-resource device and not a low-resource model
        // Or device's maxStorageBufferBindingSize does not satisfy the model's need (if specified)
        const params = new URLSearchParams(location.search);
        opt.disabled = !params.has("bypassRestrictions");
        opt.selected = false;
      }
      if (
        !modelSelector.lastChild?.textContent?.startsWith(
          opt.value.split("-")[0],
        )
      ) {
        modelSelector.appendChild(document.createElement("hr"));
      }
      modelSelector.appendChild(opt);
    }
    modelSelector.appendChild(document.createElement("hr"));

    chatUI.selectedModel = modelSelector.value;
    modelSelector.onchange = () => {
      chatUI.onSelectChange(modelSelector);
    };

    // Add welcome message
    chatUI.appendMessage("init", "Welcome to sLM! Select a model and start chatting.");

    return chatUI;
  };

  /**
   * Push a task to the execution queue.
   *
   * @param task The task to be executed;
   */
  private pushTask(task: () => Promise<void>) {
    const lastEvent = this.chatRequestChain;
    this.chatRequestChain = lastEvent.then(task);
  }
  // Event handlers
  // all event handler pushes the tasks to a queue
  // that get executed sequentially
  // the tasks previous tasks, which causes them to early stop
  // can be interrupted by engine.interruptGenerate
  private async onGenerate() {
    if (this.requestInProgress) {
      return;
    }
    this.pushTask(async () => {
      await this.asyncGenerate();
    });
  }

  private async onSelectChange(modelSelector: HTMLSelectElement) {
    if (this.requestInProgress) {
      // interrupt previous generation if any
      this.engine.interruptGenerate();
    }
    // try reset after previous requests finishes
    this.pushTask(async () => {
      await this.engine.resetChat();
      this.resetChatHistory();
      await this.unloadChat();
      this.selectedModel = modelSelector.value;
      await this.asyncInitChat();
    });
  }

  private async onReset() {
    if (this.requestInProgress) {
      // interrupt previous generation if any
      this.engine.interruptGenerate();
    }
    // try reset after previous requests finishes
    this.pushTask(async () => {
      await this.engine.resetChat();
      this.resetChatHistory();
    });
  }

  // Internal helper functions
  private appendMessage(kind, text) {
    if (kind == "init") {
      text = "[System] " + text;
    }
    if (this.uiChat === undefined) {
      throw Error("cannot find ui chat");
    }
    
    let className = "";
    if (kind === "left") {
      className = "message bot-message";
    } else if (kind === "right") {
      className = "message user-message";
    } else if (kind === "init" || kind === "error") {
      className = "message system-message";
    }
    
    const msg = `<div class="${className}">${text}</div>`;
    this.uiChat.insertAdjacentHTML("beforeend", msg);
    this.uiChat.scrollTo(0, this.uiChat.scrollHeight);
  }

  // Special care for user input such that we treat it as pure text instead of html
  private appendUserMessage(text: string) {
    if (this.uiChat === undefined) {
      throw Error("cannot find ui chat");
    }
    const div = document.createElement("div");
    div.className = "message user-message";
    div.textContent = text;
    this.uiChat.appendChild(div);
    this.uiChat.scrollTo(0, this.uiChat.scrollHeight);
  }

  private updateLastMessage(kind, text) {
    if (kind == "init") {
      text = "[System] " + text;
    }
    if (this.uiChat === undefined) {
      throw Error("cannot find ui chat");
    }
    
    let className = "";
    if (kind === "left") {
      className = "message bot-message";
    } else if (kind === "right") {
      className = "message user-message";
    } else if (kind === "init" || kind === "error") {
      className = "message system-message";
    }
    
    const matches = this.uiChat.getElementsByClassName(className);
    if (matches.length == 0) {
      throw Error(`${kind} message does not exist`);
    }
    
    const msg = matches[matches.length - 1];
    if (msg.textContent === text) return;
    
    msg.textContent = text;
    this.uiChat.scrollTo(0, this.uiChat.scrollHeight);
  }

  private resetChatHistory() {
    this.chatHistory = [];
    // Clear all messages
    this.uiChat.innerHTML = "";
    
    // Add welcome message
    this.appendMessage("init", "Chat has been reset. How can I help you?");
    
    if (this.uiChatInfoLabel !== undefined) {
      this.uiChatInfoLabel.innerHTML = "";
    }
  }

  private async asyncInitChat() {
    if (this.chatLoaded) return;
    this.requestInProgress = true;
    this.appendMessage("init", "");
    const initProgressCallback = (report) => {
      this.updateLastMessage("init", report.text);
    };
    this.engine.setInitProgressCallback(initProgressCallback);

    try {
      await this.engine.reload(this.selectedModel);
    } catch (err) {
      this.appendMessage("error", "Init error, " + err.toString());
      console.log(err.stack);
      this.unloadChat();
      this.requestInProgress = false;
      return;
    }
    this.requestInProgress = false;
    this.chatLoaded = true;
  }

  private async unloadChat() {
    await this.engine.unload();
    this.chatLoaded = false;
  }

  /**
   * Run generate
   */
  private async asyncGenerate() {
    await this.asyncInitChat();
    this.requestInProgress = true;
    const prompt = this.uiChatInput.value.trim();
    if (prompt == "") {
      this.requestInProgress = false;
      return;
    }

    this.appendUserMessage(prompt);
    this.uiChatInput.value = "";
    this.uiChatInput.style.height = "auto";
    this.uiChatInput.setAttribute("placeholder", "Generating...");

    // Show typing indicator
    this.showTypingIndicator();
    
    this.chatHistory.push({ role: "user", content: prompt });

    try {
      let curMessage = "";
      let usage: webllm.CompletionUsage | undefined = undefined;
      const completion = await this.engine.chat.completions.create({
        stream: true,
        messages: this.chatHistory,
        stream_options: { include_usage: true },
      });
      
      // Remove typing indicator and add empty bot message
      this.removeTypingIndicator();
      this.appendMessage("left", "");
      
      // Process streaming response
      for await (const chunk of completion) {
        const curDelta = chunk.choices[0]?.delta.content;
        if (curDelta) {
          curMessage += curDelta;
        }
        this.updateLastMessage("left", curMessage);
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }
      
      if (usage) {
        this.uiChatInfoLabel.innerHTML =
          `Tokens: ${usage.prompt_tokens} (prompt) + ${usage.completion_tokens} (completion) | ` +
          `Speed: ${usage.extra.prefill_tokens_per_s.toFixed(1)} tokens/s (prefill), ` +
          `${usage.extra.decode_tokens_per_s.toFixed(1)} tokens/s (decode)`;
      }
      
      const finalMessage = await this.engine.getMessage();
      this.updateLastMessage("left", finalMessage);
      this.chatHistory.push({ role: "assistant", content: finalMessage });
    } catch (err) {
      this.removeTypingIndicator();
      this.appendMessage("error", "Generate error, " + err.toString());
      console.log(err.stack);
      await this.unloadChat();
    }
    
    this.uiChatInput.setAttribute("placeholder", "Ask sLM something...");
    this.requestInProgress = false;
  }
  
  private showTypingIndicator() {
    const indicator = document.createElement("div");
    indicator.className = "message bot-message typing-indicator";
    indicator.innerHTML = '<span></span><span></span><span></span>';
    indicator.id = "typing-indicator";
    this.uiChat.appendChild(indicator);
    this.uiChat.scrollTo(0, this.uiChat.scrollHeight);
  }

  private removeTypingIndicator() {
    document.getElementById("typing-indicator")?.remove();
  }
}

// Add CSS for typing indicator
const style = document.createElement("style");
style.textContent = `
.typing-indicator {
  display: flex;
  align-items: center;
  padding: 0.5rem 1rem;
}

.typing-indicator span {
  height: 8px;
  width: 8px;
  background-color: #999;
  border-radius: 50%;
  display: inline-block;
  margin-right: 5px;
  animation: bounce 1.5s infinite ease-in-out;
}

.typing-indicator span:nth-child(1) {
  animation-delay: 0s;
}

.typing-indicator span:nth-child(2) {
  animation-delay: 0.2s;
}

.typing-indicator span:nth-child(3) {
  animation-delay: 0.4s;
  margin-right: 0;
}

@keyframes bounce {
  0%, 60%, 100% {
    transform: translateY(0);
  }
  30% {
    transform: translateY(-5px);
  }
}

.system-message {
  background-color: #f8f9fa;
  color: #666;
  font-style: italic;
  text-align: center;
  margin: 0.5rem auto;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  max-width: 80%;
}
`;
document.head.appendChild(style);

const useWebWorker = appConfig.use_web_worker;
let engine: webllm.MLCEngineInterface;

// Here we do not use `CreateMLCEngine()` but instantiate an engine that is not loaded with model
if (useWebWorker) {
  engine = new webllm.WebWorkerMLCEngine(
    new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    { appConfig, logLevel: "INFO" },
  );
} else {
  engine = new webllm.MLCEngine({ appConfig });
}
ChatUI.CreateAsync(engine);