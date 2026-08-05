const RECEIVER = "http://127.0.0.1:47821";
const SCIENCE_RECEIVER = "http://127.0.0.1:47822";
const PUBLISHER_RECEIVER = "http://127.0.0.1:47823";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "baseline") {
    fetch(`${RECEIVER}/baseline`)
      .then((response) => {
        if (!response.ok) throw new Error(`Local receiver returned HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "complete") {
    fetch(`${RECEIVER}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload),
    })
      .then((response) => response.json().then((payload) => ({ response, payload })))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error || `Local receiver returned HTTP ${response.status}`);
        sendResponse({ ok: true, payload });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "science-baseline") {
    fetch(`${SCIENCE_RECEIVER}/baseline`)
      .then((response) => {
        if (!response.ok) throw new Error(`Local receiver returned HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "science-complete") {
    fetch(`${SCIENCE_RECEIVER}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload),
    })
      .then((response) => response.json().then((payload) => ({ response, payload })))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error || `Local receiver returned HTTP ${response.status}`);
        sendResponse({ ok: true, payload });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "publisher-baseline") {
    fetch(`${PUBLISHER_RECEIVER}/baseline`)
      .then((response) => {
        if (!response.ok) throw new Error(`Local receiver returned HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "publisher-complete") {
    fetch(`${PUBLISHER_RECEIVER}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload),
    })
      .then((response) => response.json().then((payload) => ({ response, payload })))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error || `Local receiver returned HTTP ${response.status}`);
        sendResponse({ ok: true, payload });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
