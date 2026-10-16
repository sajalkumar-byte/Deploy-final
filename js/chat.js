/* chat.js – one-to-one chat in the browser.

   Live messages come over Socket.IO (a WebSocket, falling back to long polling where one is
   blocked). The Socket.IO client is fetched from the server that serves the chat, so there is no
   extra library to install and no CDN to depend on.

   Everything also works without a socket: sending falls back to an ordinary request and the
   conversation is re-read on a timer. The chat is only offered when a Node.js backend answers,
   because that is what carries the socket.

   Part of the MVP split: js/model.js · js/view.js · js/export.js · js/chat.js · js/presenter.js */

(function (global) {
  'use strict';

  const BASE = String(global.API_BASE || '').replace(/\/+$/, '');
  const url = path => BASE + path;

  class ChatClient {
    constructor(store) {
      this.store = store;             // the ApiStore, used for ordinary requests
      this.socket = null;
      this.available = false;         // does a backend offer chat at all
      this.connected = false;
      this.me = null;
      this.contacts = [];
      this.online = [];
      this.openWith = '';             // the colleague whose conversation is on screen
      this.messages = [];
      this.typingFrom = {};           // email -> timestamp of their last keystroke
      this.handlers = {};             // event -> [callback]
      this.poll = null;
    }

    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
    emit(event, payload) {
      for (const fn of this.handlers[event] || []) {
        try { fn(payload); } catch (e) { /* one broken listener must not stop the rest */ }
      }
    }

    request(method, path, body) { return this.store.request(method, path, body); }

    /* ---------- starting up ---------- */
    /** Ask the backend whether chat is on, and load the contact list. */
    async start() {
      try {
        const data = await this.request('GET', '/api/chat/contacts');
        /* Only treat chat as present when the answer really is a contact list. */
        if (!data || !data.me || !Array.isArray(data.contacts)) { this.available = false; return false; }
        this.available = true;
        this.me = data.me;
        this.contacts = data.contacts || [];
        this.online = this.contacts.filter(c => c.online).map(c => c.email);
        this.emit('contacts', this.contacts);
        this.emit('unread', this.totalUnread());
        if (data.realtime) await this.connectSocket();
        this.startPolling();
        return true;
      } catch (e) {
        this.available = false;
        return false;
      }
    }

    stop() {
      if (this.poll) { clearInterval(this.poll); this.poll = null; }
      if (this.socket) { try { this.socket.close(); } catch (e) {} this.socket = null; }
      this.connected = false;
      this.available = false;
      this.contacts = [];
      this.messages = [];
      this.openWith = '';
    }

    /** Load the Socket.IO client from the backend, then connect with the session. */
    async connectSocket() {
      if (this.socket) return this.socket;
      try {
        if (!global.io) await loadScript(url('/socket.io/socket.io.js'));
        if (!global.io) return null;
      } catch (e) {
        return null;                    // the page still works without live delivery
      }

      const token = (this.store.session && this.store.session.token) || '';
      const socket = global.io(BASE || undefined, {
        path: '/socket.io',
        withCredentials: true,          // lets the session cookie authenticate after a reload
        auth: token ? { token } : {},
        transports: ['websocket', 'polling'],
      });

      socket.on('connect', () => { this.connected = true; this.emit('status', { connected: true }); });
      socket.on('disconnect', () => { this.connected = false; this.emit('status', { connected: false }); });
      socket.on('connect_error', () => { this.connected = false; this.emit('status', { connected: false }); });

      socket.on('chat:message', message => this.receive(message));
      socket.on('chat:read', ({ by }) => {
        if (by && by === this.openWith) {
          this.messages.forEach(m => { if (m.from !== by && !m.readAt) m.readAt = new Date().toISOString(); });
          this.emit('messages', this.messages);
        }
      });
      socket.on('chat:typing', ({ from, typing }) => {
        this.typingFrom[from] = typing ? Date.now() : 0;
        this.emit('typing', { from, typing });
      });
      socket.on('presence', ({ online }) => {
        this.online = online || [];
        this.contacts.forEach(c => { c.online = this.online.includes(c.email); });
        this.emit('contacts', this.contacts);
      });

      this.socket = socket;
      return socket;
    }

    /** Without a socket, catch up every few seconds instead. */
    startPolling() {
      if (this.poll) return;
      this.poll = setInterval(async () => {
        if (document.hidden || !this.available) return;
        if (this.connected) { await this.refreshContacts(); return; }   // sockets carry the messages
        await this.refreshContacts();
        if (this.openWith) await this.openConversation(this.openWith, { quiet: true });
      }, 7000);
    }

    /* ---------- contacts and conversations ---------- */
    async refreshContacts() {
      try {
        const data = await this.request('GET', '/api/chat/contacts');
        this.contacts = data.contacts || [];
        this.online = this.contacts.filter(c => c.online).map(c => c.email);
        this.emit('contacts', this.contacts);
        this.emit('unread', this.totalUnread());
      } catch (e) { /* a dropped poll is not worth reporting */ }
    }

    totalUnread() {
      return this.contacts.reduce((sum, c) => sum + (Number(c.unread) || 0), 0);
    }

    contact(email) {
      return this.contacts.find(c => c.email === email) || null;
    }

    async openConversation(email, { quiet = false } = {}) {
      this.openWith = email;
      if (!quiet) this.emit('opening', email);
      const data = await this.request('GET', `/api/chat/with/${encodeURIComponent(email)}`);
      this.messages = data.messages || [];
      const person = this.contact(email);
      if (person) person.unread = 0;
      this.emit('messages', this.messages);
      this.emit('contacts', this.contacts);
      this.emit('unread', this.totalUnread());
      return data;
    }

    /** A message arrived, either for the open conversation or for someone else. */
    receive(message) {
      const mine = this.me && this.me.email;
      const other = message.from === mine ? message.to : message.from;

      if (other === this.openWith) {
        if (!this.messages.some(m => m.id === message.id)) this.messages.push(message);
        this.emit('messages', this.messages);
        if (message.from !== mine) this.markRead(other);
      } else if (message.from !== mine) {
        const person = this.contact(other);
        if (person) { person.unread = (Number(person.unread) || 0) + 1; }
        this.emit('contacts', this.contacts);
        this.emit('unread', this.totalUnread());
        this.emit('notify', message);
      }

      const person = this.contact(other);
      if (person) {
        person.lastAt = message.at;
        person.lastBody = String(message.body).slice(0, 80);
        person.lastFromMe = message.from === mine;
      }
    }

    async send(to, body) {
      const text = String(body || '').trim();
      if (!text) return null;

      if (this.socket && this.connected) {
        const reply = await new Promise(resolve => {
          let settled = false;
          const done = r => { if (!settled) { settled = true; resolve(r); } };
          this.socket.emit('chat:send', { to, body: text }, done);
          setTimeout(() => done(null), 6000);
        });
        if (reply && reply.ok) return reply.message;
        if (reply && reply.error) throw new Error(reply.error);
        /* no answer in time: fall through and send it the ordinary way */
      }

      const message = await this.request('POST', `/api/chat/with/${encodeURIComponent(to)}`, { body: text });
      this.receive(message);
      return message;
    }

    markRead(email) {
      if (this.socket && this.connected) { this.socket.emit('chat:read', { from: email }); return; }
      this.request('POST', `/api/chat/read/${encodeURIComponent(email)}`).catch(() => {});
    }

    typing(to, isTyping) {
      if (this.socket && this.connected) this.socket.emit('chat:typing', { to, typing: Boolean(isTyping) });
    }

    isTyping(email) {
      const at = this.typingFrom[email] || 0;
      return at > 0 && Date.now() - at < 4000;
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.onload = resolve;
      tag.onerror = () => reject(new Error('Could not load the chat library'));
      document.head.appendChild(tag);
    });
  }

  global.ChatClient = ChatClient;
})(window);
