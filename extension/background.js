const RECEIVER = "http://127.0.0.1:47821";
const SCIENCE_RECEIVER = "http://127.0.0.1:47822";
const PUBLISHER_RECEIVER = "http://127.0.0.1:47823";
const COLLECTOR_ALARM_PREFIX = "collector-tab:";
const COLLECTOR_TIMEOUT_MINUTES = 10;

function automatedCollectorTabId(sender) {
  const tabId = sender?.tab?.id;
  const url = sender?.tab?.url || sender?.url || "";
  if (!Number.isInteger(tabId)) return null;
  if (!/#(?:jacs|science|publisher)-auto$/.test(url)) return null;
  return tabId;
}

function collectorAlarmName(tabId) {
  return `${COLLECTOR_ALARM_PREFIX}${tabId}`;
}

function armCollectorCleanup(sender) {
  const tabId = automatedCollectorTabId(sender);
  if (tabId === null) return;
  chrome.alarms.create(collectorAlarmName(tabId), { delayInMinutes: COLLECTOR_TIMEOUT_MINUTES });
}

function closeCollectorTab(sender) {
  const tabId = automatedCollectorTabId(sender);
  if (tabId === null) return;
  chrome.alarms.clear(collectorAlarmName(tabId));
  setTimeout(() => {
    chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
  }, 750);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(COLLECTOR_ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(COLLECTOR_ALARM_PREFIX.length));
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.alarms.clear(collectorAlarmName(tabId));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "baseline") {
    armCollectorCleanup(sender);
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
        closeCollectorTab(sender);
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "progress") {
    armCollectorCleanup(sender);
    fetch(`${RECEIVER}/heartbeat`)
      .then((response) => {
        if (!response.ok) throw new Error(`Local receiver returned HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "science-baseline") {
    armCollectorCleanup(sender);
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
        closeCollectorTab(sender);
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "publisher-baseline") {
    armCollectorCleanup(sender);
    fetch(`${PUBLISHER_RECEIVER}/baseline${message.reset ? "?reset=1" : ""}`)
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
        closeCollectorTab(sender);
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "publisher-batch") {
    armCollectorCleanup(sender);
    fetch(`${PUBLISHER_RECEIVER}/batch`, {
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
