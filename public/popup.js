const sendButton = document.querySelector("#send-button");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const statusElement = document.querySelector("#status");
const resultsElement = document.querySelector("#results");
const projectCountElement = document.querySelector("#project-count");
const tableHeadElement = document.querySelector("thead");
const tableBodyElement = document.querySelector("tbody");
const destinationElement = document.querySelector("#destination");
let requestInProgress = false;
let serverAutoFetchActive = false;
let autoFetchCommandInProgress = false;
const SERVER_BASE_URL = /^https?:$/.test(globalThis.location.protocol)
  ? globalThis.location.origin
  : globalThis.SERVER_BASE_URL.replace(/\/+$/, "");
destinationElement.textContent =
  `Server endpoint: ${SERVER_BASE_URL}/fetch_projects`;

async function postToServer(endpoint) {
  const response = await fetch(
    `${SERVER_BASE_URL}${endpoint}`,
    { method: "POST" },
  );
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Local server returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || `Local server returned HTTP ${response.status}.`);
  }
  return result;
}

function flattenProject(project) {
  const fields = {};

  function visit(value, path) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    ) {
      for (const [key, nestedValue] of Object.entries(value)) {
        visit(nestedValue, path ? `${path}.${key}` : key);
      }
      return;
    }

    fields[path] =
      value !== null && typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  }

  for (const [key, value] of Object.entries(project)) {
    visit(value, key);
  }

  return fields;
}

function renderProjects(projects) {
  const flattenedProjects = projects.map(flattenProject);
  const columns = [...new Set(flattenedProjects.flatMap(Object.keys))];

  tableHeadElement.replaceChildren();
  tableBodyElement.replaceChildren();

  const headerRow = document.createElement("tr");
  for (const column of columns) {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = column;
    headerRow.append(header);
  }
  tableHeadElement.append(headerRow);

  for (const project of flattenedProjects) {
    const row = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("td");
      cell.textContent = project[column] ?? "";
      row.append(cell);
    }
    tableBodyElement.append(row);
  }

  projectCountElement.textContent = `(${projects.length})`;
  resultsElement.hidden = false;
}

async function fetchAndForwardProjects() {
  if (requestInProgress) return false;
  requestInProgress = true;
  statusElement.dataset.state = "working";
  statusElement.textContent = "Fetching projects...";

  try {
    const result = await postToServer("/fetch_projects");
    if (Array.isArray(result.projects)) {
      renderProjects(result.projects);
    }

    statusElement.dataset.state = "success";
    statusElement.textContent = result.message;
    return true;
  } catch (error) {
    statusElement.dataset.state = "error";
    statusElement.textContent = error.message;
    return false;
  } finally {
    requestInProgress = false;
  }
}

sendButton.addEventListener("click", async () => {
  sendButton.disabled = true;
  try {
    await fetchAndForwardProjects();
  } finally {
    sendButton.disabled = serverAutoFetchActive || autoFetchCommandInProgress;
  }
});

function updateRepeatControls(active) {
  serverAutoFetchActive = active;
  startButton.disabled = active || autoFetchCommandInProgress;
  stopButton.disabled = !active || autoFetchCommandInProgress;
  sendButton.disabled = active || autoFetchCommandInProgress;
}

startButton.addEventListener("click", async () => {
  autoFetchCommandInProgress = true;
  updateRepeatControls(serverAutoFetchActive);
  try {
    const result = await postToServer("/auto_fetch/start");
    updateRepeatControls(true);
    statusElement.dataset.state = "working";
    statusElement.textContent = result.message;
  } catch (error) {
    startButton.disabled = false;
    statusElement.dataset.state = "error";
    statusElement.textContent = error.message;
  } finally {
    autoFetchCommandInProgress = false;
    updateRepeatControls(serverAutoFetchActive);
  }
});

stopButton.addEventListener("click", async () => {
  autoFetchCommandInProgress = true;
  updateRepeatControls(serverAutoFetchActive);
  try {
    const result = await postToServer("/auto_fetch/stop");
    updateRepeatControls(false);
    statusElement.dataset.state = "success";
    statusElement.textContent = result.message;
  } catch (error) {
    stopButton.disabled = false;
    statusElement.dataset.state = "error";
    statusElement.textContent = error.message;
  } finally {
    autoFetchCommandInProgress = false;
    updateRepeatControls(serverAutoFetchActive);
  }
});
