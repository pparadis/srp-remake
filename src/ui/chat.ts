// The online chat panel: one element, built once. main.ts owns the socket and the lobby, and moves this element to
// the lobby card or the race HUD. Phaser-free; messages are shown with textContent only.
import { CHAT_MAX_GRAPHEMES, chatLength, normalizeChatText } from '../game/chat_text';
import { must } from '../game/must';
import type { ChatMessage } from '../net/backend_api';

/** Messages kept (and drawn): the server keeps 50 per lobby too. */
const KEEP = 50;

const TEMPLATE = `
<ol class="chat-list" data-testid="chat-list" aria-live="polite"></ol>
<div class="chat-muted" data-testid="chat-muted" hidden></div>
<form class="chat-form" data-testid="chat-form" autocomplete="off">
  <input class="chat-input" data-testid="chat-input" type="text" aria-label="Chat message" placeholder="Say something" enterkeyhint="send">
  <span class="chat-count" data-testid="chat-count">0/${CHAT_MAX_GRAPHEMES}</span>
  <button type="submit" class="chat-send" data-testid="chat-send" disabled>Send</button>
</form>
<div class="chat-error" data-testid="chat-error" role="alert" hidden></div>
`;

export function isChatMessage(value: unknown): value is ChatMessage {
  const m = value as Partial<Record<keyof ChatMessage, unknown>> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.id === 'number' &&
    typeof m.playerId === 'string' &&
    typeof m.name === 'string' &&
    typeof m.text === 'string'
  );
}

export interface ChatOptions {
  /** Sends the text; rejects with an Error whose message is shown under the input. */
  send(text: string): Promise<void>;
}

function mutedKey(lobbyId: string): string {
  return `srp:chat-muted:${lobbyId}`;
}

function loadMuted(lobbyId: string): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(mutedKey(lobbyId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    );
  } catch {
    return new Set();
  }
}

function storeMuted(lobbyId: string, muted: Set<string>) {
  try {
    window.sessionStorage.setItem(mutedKey(lobbyId), JSON.stringify([...muted]));
  } catch {
    // storage unavailable: the mute lasts until the page closes
  }
}

export function createChat(options: ChatOptions) {
  const element = document.createElement('section');
  element.className = 'chat';
  element.dataset.testid = 'chat';
  element.innerHTML = TEMPLATE;
  const q = <T extends HTMLElement>(id: string) =>
    must(element.querySelector<T>(`[data-testid="${id}"]`), `chat element ${id}`);
  const list = q('chat-list');
  const mutedBar = q('chat-muted');
  const form = q<HTMLFormElement>('chat-form');
  const input = q<HTMLInputElement>('chat-input');
  const count = q('chat-count');
  const sendButton = q<HTMLButtonElement>('chat-send');
  const errorLine = q('chat-error');

  let lobbyId: string | null = null;
  let selfId: string | null = null;
  let messages: ChatMessage[] = [];
  let muted = new Set<string>();
  // Names seen, so the muted bar can say who is muted.
  const names = new Map<string, string>();
  let sending = false;
  let seen = true;
  let unread = 0;
  let unreadListener: (count: number) => void = () => undefined;

  function setUnread(next: number) {
    if (next === unread) return;
    unread = next;
    unreadListener(unread);
  }

  function setError(text: string | null) {
    errorLine.hidden = text === null;
    errorLine.textContent = text ?? '';
  }

  function renderInput() {
    const length = chatLength(input.value);
    count.textContent = `${length}/${CHAT_MAX_GRAPHEMES}`;
    const normalized = normalizeChatText(input.value);
    count.classList.toggle('is-over', !normalized.ok && normalized.reason === 'too_long');
    sendButton.disabled = sending || !normalized.ok;
  }

  function toggleMute(playerId: string) {
    if (muted.has(playerId)) muted.delete(playerId);
    else muted.add(playerId);
    if (lobbyId) storeMuted(lobbyId, muted);
    render();
  }

  function render() {
    list.replaceChildren();
    for (const message of messages) {
      if (muted.has(message.playerId)) continue;
      const row = document.createElement('li');
      row.dataset.author = message.playerId;
      const name = document.createElement('span');
      name.className = 'chat-name';
      name.textContent = message.name;
      const text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = message.text;
      row.append(name, ' ', text);
      if (message.playerId !== selfId) {
        const mute = document.createElement('button');
        mute.type = 'button';
        mute.className = 'chat-mute';
        mute.dataset.testid = 'chat-mute';
        mute.textContent = 'Mute';
        mute.title = `Mute ${message.name} on your screen`;
        mute.setAttribute('aria-label', `Mute ${message.name}`);
        mute.addEventListener('click', () => toggleMute(message.playerId));
        row.append(mute);
      }
      list.append(row);
    }
    list.scrollTop = list.scrollHeight;

    // A muted author is only listed once a message of theirs has shown who they are.
    const mutedNames = [...muted].filter((id) => names.has(id));
    mutedBar.hidden = mutedNames.length === 0;
    mutedBar.replaceChildren();
    if (mutedNames.length > 0) {
      mutedBar.append('Muted: ');
      for (const id of mutedNames) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-unmute';
        button.dataset.testid = 'chat-unmute';
        button.textContent = `${names.get(id)} ✕`;
        button.setAttribute('aria-label', `Unmute ${names.get(id)}`);
        button.addEventListener('click', () => toggleMute(id));
        mutedBar.append(button);
      }
    }
  }

  function remember(message: ChatMessage) {
    names.set(message.playerId, message.name);
  }

  input.addEventListener('input', () => {
    setError(null);
    renderInput();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') input.blur();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const normalized = normalizeChatText(input.value);
    if (!normalized.ok || sending) return;
    sending = true;
    renderInput();
    try {
      await options.send(normalized.text);
      input.value = '';
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not send');
    } finally {
      sending = false;
      renderInput();
    }
  });

  return {
    element,

    /** A new lobby (or the same one again): forgets the messages, loads who this tab muted. */
    open(nextLobbyId: string, selfPlayerId: string) {
      lobbyId = nextLobbyId;
      selfId = selfPlayerId;
      messages = [];
      names.clear();
      muted = loadMuted(nextLobbyId);
      setUnread(0);
      setError(null);
      render();
    },

    close() {
      lobbyId = null;
      selfId = null;
      messages = [];
      names.clear();
      muted = new Set();
      setUnread(0);
      input.value = '';
      renderInput();
      render();
    },

    /** `chat.history`: replaces everything (a reconnect sends it again). Never counts as unread. */
    setHistory(history: ChatMessage[]) {
      messages = history.slice(-KEEP);
      for (const message of messages) remember(message);
      render();
    },

    /** `chat.message`, or the reply to our own send: the same message can arrive twice. */
    add(message: ChatMessage) {
      if (messages.some((existing) => existing.id === message.id)) return;
      remember(message);
      messages = [...messages, message].slice(-KEEP);
      if (!seen && message.playerId !== selfId && !muted.has(message.playerId)) {
        setUnread(unread + 1);
      }
      render();
    },

    /** Whether the player can see the panel right now; seeing it clears the unread count. */
    setSeen(next: boolean) {
      seen = next;
      if (seen) setUnread(0);
    },

    onUnread(listener: (count: number) => void) {
      unreadListener = listener;
    },

    focus() {
      input.focus();
    }
  };
}

export type ChatPanel = ReturnType<typeof createChat>;
