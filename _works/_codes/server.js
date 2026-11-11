/**
timeStamp
title
href

href
timeStamp
ProjectTitle
ProjectBudget
    ProjectType
    BudgetCurrencyChar
    BudgetCurrency
    MinBudget
    MaxBudget
ProjectDescription
Location
Country
Star
Member
    MemberDayOld
Review
Identity_verified
Payment_verified
Deposit_made
Email_verified
Profile_completed
Phone_verified
Prefered
IPA
NDA
Restricted
Australian

    PlanBid

    ProposalText
    ProposalBudget
    ProposalTime


Conclusion

MinBudget_USD
MaxBudget_USD
MinBudgetGroup
MaxBudgetGroup




**/

import express from "express";
import { google } from "googleapis";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import dotenv from "dotenv";



import getFormatedLocalTime, {
    formatJstDateTime,
    isProjectRegisteredWithinLast24Hours,
    parseJstTimestamp,
} from './_toolkit/getFormatedLocalTime.js';

import projectPlanner_PlanBid, { normalizePlanBidSettings } from './projectPlanner_PlanBid.js';
import Force_ProjectAnalyser from './Force_ProjectAnalyser.js';
import proposalMaker from './proposalMaker.js';
import evaluateProjectFeasibility from './projectFeasibilityEvaluator.js';
import {
    getMatchedSkills,
    normalizeFeasibilitySettings,
    parseProjectJobs,
} from './projectSkills.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FORWARDER_UI_ROOT = path.resolve(SERVER_ROOT, "..", "get projects");
dotenv.config({ path: path.join(SERVER_ROOT, ".env") });

const app = express();
const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || "0.0.0.0";
const PROJECT_POLL_INTERVAL_MS = 10_000;
const corsOrigins = (process.env.CORS_ORIGINS || "*")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

// Middleware
app.use(cors({
    origin: corsOrigins.includes("*") ? "*" : corsOrigins,
    methods: ["GET", "POST"], // Allowed HTTP methods
    allowedHeaders: ["Content-Type"] // Allowed headers
}));
app.use(bodyParser.json({ limit: "10mb" }));

app.use(express.static(FORWARDER_UI_ROOT));

app.get("/", (_req, res) => {
    res.sendFile(path.join(FORWARDER_UI_ROOT, "popup.html"));
});

app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

app.post("/fetch_projects", handleFetchProjects);
app.post("/auto_fetch/start", handleStartAutoFetch);
app.post("/auto_fetch/stop", handleStopAutoFetch);

// Google Sheets API configuration
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SHEET_ID = process.env.SHEET_ID;
if (!SHEET_ID) {
    throw new Error("SHEET_ID must be set in the server .env file or hosting environment.");
}

const googleAuthOptions = {
    scopes: SCOPES,
};
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    googleAuthOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    googleAuthOptions.keyFile = path.resolve(SERVER_ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);
}
const auth = new google.auth.GoogleAuth(googleAuthOptions);

const ALARM_SHEET_NAME = process.env.ALARM_SHEET_NAME || "Alarms";
const API_PROJECTS_SHEET_NAME = process.env.API_PROJECTS_SHEET_NAME || "API_projects";
const MY_EVENTS_SHEET_NAME = process.env.MY_EVENTS_SHEET_NAME || "My Events";
const PROFILE_SHEET_NAME = process.env.PROFILE_SHEET_NAME || "Profile";
const MY_EVENTS_FIELDS = [
    { key: "Date/Time", aliases: ["Date/Time"] },
    { key: "Project ID", aliases: ["Project ID"] },
    { key: "Project URL", aliases: ["Project URL"] },
    { key: "Account", aliases: ["Account", "username", "acccount"] },
    { key: "Bid Status", aliases: ["Bid Status"] },
    { key: "Status Reason", aliases: ["Status Reason"] },
    { key: "Proposal", aliases: ["Proposal"] },
];

////////////////////////////////////////////sheet

let globalHeaderIndexes_API_Projects = {};
let globalHeaders_API_Projects = [];
let globalHeaderIndexes_MyEvents = {};
let globalHeaders_MyEvents = [];
let globalHeaders_Profile = [];
let apiProjectsLastRow = 1;
const knownApiProjectIds = new Set();
const attemptedProjectsByUser = new Map();
const pendingProposalsByUser = new Map();
const bidAttemptsById = new Map();
const selectionCursors = {};
const selectionCursorPath = path.join(SERVER_ROOT, ".autobid-cursors.json");
const selectionLocks = new Map();

const globalSheetId = SHEET_ID;
const globalAuth = auth;

async function getHeaderIndexes(headers) {
    const headerIndexes = {};
    headers.forEach((header, index) => {
        const trimmedHeader = header.trim();
        if (trimmedHeader !== "") {
            headerIndexes[trimmedHeader] = index;
        }
    });
    return headerIndexes;
}
async function initializeHeaderIndexes() {
    const client = await globalAuth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });

    const headerResponse_API_Projects = await sheets.spreadsheets.values.get({
        spreadsheetId: globalSheetId,
        range: `${API_PROJECTS_SHEET_NAME}!1:1`,
    });

    globalHeaders_API_Projects = headerResponse_API_Projects.data.values?.[0] || [];
    if (globalHeaders_API_Projects.length === 0) {
        throw new Error(`The ${API_PROJECTS_SHEET_NAME} sheet must have a header row.`);
    }
    globalHeaderIndexes_API_Projects = await getHeaderIndexes(globalHeaders_API_Projects);
    const requiredBudgetHeaders = [
        ["MinBudget_USD"],
        ["MaxBudget_USD"],
        ["MinBudgetGroup"],
        ["MaxBudgetGroup"],
    ];
    const missingBudgetHeaders = requiredBudgetHeaders
        .filter(aliases => getHeaderIndexByName(globalHeaders_API_Projects, aliases) < 0)
        .map(aliases => aliases[0]);
    if (missingBudgetHeaders.length > 0) {
        throw new Error(
            `The ${API_PROJECTS_SHEET_NAME} sheet needs budget output columns: ${missingBudgetHeaders.join(", ")}.`
        );
    }
    if (getHeaderIndexByName(globalHeaders_API_Projects, ["timestamp", "timeStamp", "Date/Time"]) < 0) {
        throw new Error(
            `The ${API_PROJECTS_SHEET_NAME} sheet needs a timestamp column to enforce the 24-hour project age limit.`
        );
    }


    const headerResponse_MyEvents = await sheets.spreadsheets.values.get({
        spreadsheetId: globalSheetId,
        range: getSheetA1Range(MY_EVENTS_SHEET_NAME, "1:1"),
    });

    globalHeaders_MyEvents = headerResponse_MyEvents.data.values?.[0] || [];
    if (globalHeaders_MyEvents.length === 0) {
        throw new Error(
            `The ${MY_EVENTS_SHEET_NAME} sheet needs the headers: `
            + `${MY_EVENTS_FIELDS.map(field => field.key).join(", ")}.`
        );
    }
    globalHeaderIndexes_MyEvents = await getHeaderIndexes(globalHeaders_MyEvents);
    const missingMyEventsHeaders = MY_EVENTS_FIELDS
        .filter(field => getHeaderIndexByName(globalHeaders_MyEvents, field.aliases) < 0)
        .map(field => field.key);
    if (missingMyEventsHeaders.length > 0) {
        throw new Error(
            `The ${MY_EVENTS_SHEET_NAME} sheet is missing required headers: `
            + `${missingMyEventsHeaders.join(", ")}.`
        );
    }

    const headerResponse_Profile = await sheets.spreadsheets.values.get({
        spreadsheetId: globalSheetId,
        range: `${PROFILE_SHEET_NAME}!1:1`,
    });
    globalHeaders_Profile = headerResponse_Profile.data.values?.[0] || [];
    if (globalHeaders_Profile.length === 0) {
        throw new Error(`The ${PROFILE_SHEET_NAME} sheet must have a header row.`);
    }
    if (getHeaderIndexByName(globalHeaders_Profile, ["username"]) < 0
        || getHeaderIndexByName(globalHeaders_Profile, ["aboutme", "about me", "about_me"]) < 0
        || getHeaderIndexByName(globalHeaders_Profile, ["skills"]) < 0
        || getHeaderIndexByName(globalHeaders_Profile, ["prompt", "script"]) < 0
        || getHeaderIndexByName(globalHeaders_Profile, ["conclusion_AI_key"]) < 0
        || getHeaderIndexByName(globalHeaders_Profile, ["Gemini_API_key"]) < 0) {
        throw new Error(
            `The ${PROFILE_SHEET_NAME} sheet needs username, aboutme, skills, prompt (or script), `
            + `conclusion_AI_key, and Gemini_API_key columns. `
            + `Headers read from row 1: ${JSON.stringify(globalHeaders_Profile)}`
        );
    }
}

let apiProjectsWriteQueue = Promise.resolve();

function withApiProjectsWriteLock(operation) {
    const operationPromise = apiProjectsWriteQueue.then(operation);
    apiProjectsWriteQueue = operationPromise.then(() => undefined, () => undefined);
    return operationPromise;
}

function getProjectId(item) {
    const value = item.id ?? item.project_id ?? item.projectId;
    return value === undefined || value === null || String(value).trim() === ""
        ? ""
        : String(value).trim();
}

function getHeaderIndexByName(headers, acceptedNames) {
    const normalizedNames = new Set(acceptedNames.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, "")));
    return headers.findIndex(header =>
        normalizedNames.has(String(header).trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
    );
}

function normalizeHeaderName(header) {
    return String(header).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getRowValue(row, acceptedNames) {
    const normalizedNames = new Set(acceptedNames.map(normalizeHeaderName));
    const matchedHeader = Object.keys(row).find(header => normalizedNames.has(normalizeHeaderName(header)));
    return matchedHeader === undefined ? undefined : row[matchedHeader];
}

function getSheetA1Range(sheetName, range) {
    const escapedSheetName = String(sheetName).replace(/'/g, "''");
    return `'${escapedSheetName}'!${range}`;
}

async function readSheetRows(sheetName, headers) {
    if (!headers || headers.length === 0) {
        throw new Error(`The ${sheetName} sheet headers have not been initialized.`);
    }

    const lastColumn = getColumnLetter_ABD(headers.length - 1);
    const client = await globalAuth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: globalSheetId,
        range: getSheetA1Range(sheetName, `A2:${lastColumn}`),
    });

    return (response.data.values || []).map(values => {
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] ?? "";
        });
        return row;
    });
}

async function readSheetRowsRange(sheetName, headers, startRow, endRow) {
    if (!headers || headers.length === 0) {
        throw new Error(`The ${sheetName} sheet headers have not been initialized.`);
    }

    const lastColumn = getColumnLetter_ABD(headers.length - 1);
    const client = await globalAuth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: globalSheetId,
        range: getSheetA1Range(sheetName, `A${startRow}:${lastColumn}${endRow}`),
    });

    return (response.data.values || []).map(values => {
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] ?? "";
        });
        return row;
    });
}

async function initializeProjectSelectionState() {
    const idColumnIndex = getHeaderIndexByName(globalHeaders_API_Projects, ["id", "project_id", "projectId"]);
    if (idColumnIndex < 0) {
        throw new Error(`The ${API_PROJECTS_SHEET_NAME} sheet needs an id column for duplicate detection.`);
    }

    const idColumn = getColumnLetter_ABD(idColumnIndex);
    const client = await globalAuth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    const [projectIdsResponse, bidEvents] = await Promise.all([
        sheets.spreadsheets.values.get({
            spreadsheetId: globalSheetId,
            range: `${API_PROJECTS_SHEET_NAME}!${idColumn}2:${idColumn}`,
        }),
        readSheetRows(MY_EVENTS_SHEET_NAME, globalHeaders_MyEvents),
    ]);

    const projectIds = projectIdsResponse.data.values || [];
    apiProjectsLastRow = projectIds.length + 1;
    for (const row of projectIds) {
        const id = String(row[0] ?? "").trim();
        if (id) knownApiProjectIds.add(id);
    }
    for (const event of bidEvents) {
        indexAttemptedProject(event);
    }

    if (fs.existsSync(selectionCursorPath)) {
        const savedCursors = JSON.parse(fs.readFileSync(selectionCursorPath, "utf8"));
        if (!savedCursors || typeof savedCursors !== "object" || Array.isArray(savedCursors)) {
            throw new Error("Auto-bid cursor state file must contain an object.");
        }
        for (const [username, cursor] of Object.entries(savedCursors)) {
            if (!cursor || !Number.isInteger(cursor.nextRow) || cursor.nextRow < 2
                || (cursor.pendingRow !== null && cursor.pendingRow !== undefined
                    && (!Number.isInteger(cursor.pendingRow) || cursor.pendingRow < 2))
                || typeof (cursor.pendingProjectId ?? "") !== "string") {
                throw new Error(`Invalid auto-bid cursor state for username "${username}".`);
            }
            cursor.pendingRow ??= null;
            cursor.pendingProjectId ??= "";
        }
        Object.assign(selectionCursors, savedCursors);
    }
}

function saveSelectionCursors() {
    const temporaryPath = `${selectionCursorPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(selectionCursors), "utf8");
    fs.renameSync(temporaryPath, selectionCursorPath);
}

function getSelectionCursor(username) {
    const normalizedUsername = normalizeUsername(username);
    if (!selectionCursors[normalizedUsername]) {
        selectionCursors[normalizedUsername] = { nextRow: 2, pendingRow: null, pendingProjectId: "" };
        saveSelectionCursors();
    }
    return selectionCursors[normalizedUsername];
}

function indexAttemptedProject(event) {
    const username = normalizeUsername(getRowValue(event, ["account", "username", "acccount"]));
    const status = String(getRowValue(event, ["bid status", "result", "status", "bid_status"]) ?? "").trim();
    const projectId = String(getRowValue(event, ["project id", "project_id", "projectId", "projectid"]) ?? "").trim();
    const href = normalizeProjectHref(String(getRowValue(event, ["project url", "href", "url"]) ?? ""));
    if (!username || !status) return;

    let attempted = attemptedProjectsByUser.get(username);
    if (!attempted) {
        attempted = new Set();
        attemptedProjectsByUser.set(username, attempted);
    }
    if (projectId) attempted.add(projectId);
    if (href) attempted.add(href);
}

function hasAttemptedProject(username, project) {
    const attempted = attemptedProjectsByUser.get(normalizeUsername(username));
    if (!attempted) return false;
    return (project.id && attempted.has(project.id))
        || (project.href && attempted.has(normalizeProjectHref(project.href)));
}

function withSelectionLock(username, operation) {
    const key = normalizeUsername(username);
    const previous = selectionLocks.get(key) || Promise.resolve();
    const current = previous.then(operation);
    selectionLocks.set(key, current.then(() => undefined, () => undefined));
    return current;
}

function normalizeUsername(username) {
    return String(username ?? "").trim().replace(/^@/, "").toLowerCase();
}

async function getUserProfile(username) {
    const profiles = await readSheetRows(PROFILE_SHEET_NAME, globalHeaders_Profile);
    const profile = profiles.find(row =>
        normalizeUsername(getRowValue(row, ["username"])) === normalizeUsername(username)
    );
    if (!profile) {
        const error = new Error(`No profile was found for username "${username}".`);
        error.status = 404;
        throw error;
    }

    const aboutMe = getRowValue(profile, ["about me", "about_me", "aboutMe"]);
    if (typeof aboutMe !== "string" || aboutMe.trim() === "") {
        const error = new Error(`The profile for username "${username}" has no about me text.`);
        error.status = 422;
        throw error;
    }
    const skills = getRowValue(profile, ["skills"]);
    if (typeof skills !== "string" || skills.trim() === "") {
        const error = new Error(`The profile for username "${username}" has no skills.`);
        error.status = 422;
        throw error;
    }
    const conclusionAiKey = getRowValue(profile, ["conclusion_AI_key"]);
    if (typeof conclusionAiKey !== "string" || conclusionAiKey.trim() === "") {
        const error = new Error(`The profile for username "${username}" has no conclusion_AI_key.`);
        error.status = 422;
        throw error;
    }
    const geminiApiKey = getRowValue(profile, ["Gemini_API_key"]);
    if (typeof geminiApiKey !== "string" || geminiApiKey.trim() === "") {
        const error = new Error(
            `The Gemini_API_key cell is blank for username "${username}". `
            + `Check the selected profile row and confirm the server is using the intended spreadsheet.`
        );
        error.status = 422;
        throw error;
    }
    return {
        aboutMe: aboutMe.trim(),
        skills: skills.trim(),
        prompt: String(getRowValue(profile, ["prompt", "script"]) ?? "").trim(),
        conclusionAiKey: conclusionAiKey.trim(),
        geminiApiKey: geminiApiKey.trim(),
    };
}

function normalizeSheetFlag(value) {
    if (typeof value === "boolean") return value;
    return ["true", "yes", "1", "good", "success", "successful", "placed", "bid placed"]
        .includes(String(value ?? "").trim().toLowerCase());
}

function toFreelancerProjectDetailUrl(rawHref) {
    const value = String(rawHref ?? "").trim();
    if (!value) return "";

    let pathname;
    try {
        pathname = new URL(value, "https://www.freelancer.com").pathname;
    } catch {
        return "";
    }

    if (/^\/projects\//i.test(pathname)) {
        return `https://www.freelancer.com${pathname.replace(/\/+$/, "").replace(/\/details$/i, "")}/details`;
    }

    const projectPath = pathname.replace(/^\/+|\/+$/g, "").replace(/\/details$/i, "");
    return projectPath
        ? `https://www.freelancer.com/projects/${projectPath}/details`
        : "";
}

function mapApiProjectRow(row, planBidSettings) {
    const project = { ...row };
    project.id = String(getRowValue(row, ["id", "project_id", "projectId"]) ?? "").trim();
    project.ProjectTitle = String(getRowValue(row, ["title", "ProjectTitle", "project_title"]) ?? "");
    project.ProjectDescription = String(getRowValue(row, ["description", "ProjectDescription", "project_description"]) ?? "");

    const rawHref = String(getRowValue(row, ["seo_url", "href", "url"]) ?? "").trim();
    if (rawHref) {
        project.href = toFreelancerProjectDetailUrl(rawHref);
    }

    const rawType = String(getRowValue(row, ["type", "ProjectType", "project_type"]) ?? "").trim().toLowerCase();
    project.ProjectType = rawType.includes("hourly") ? "Hourly" : rawType.includes("fixed") ? "Fixed" : rawType;
    project.MinBudget = Number(getNestedValue(row, "budget.minimum")
        ?? getRowValue(row, ["budget.minimum", "MinBudget", "min_budget"])) || 0;
    project.MaxBudget = Number(getNestedValue(row, "budget.maximum")
        ?? getRowValue(row, ["budget.maximum", "MaxBudget", "max_budget"])) || 0;
    project.BudgetCurrency = String(getNestedValue(row, "currency.code")
        ?? getRowValue(row, ["currency.code", "BudgetCurrency", "budget_currency"]) ?? "");
    project.BudgetCurrencyCountry = String(getNestedValue(row, "currency.country")
        ?? getRowValue(row, ["currency.country", "BudgetCurrencyCountry"]) ?? "");
    project.BudgetCurrencyChar = String(getRowValue(row, ["currency.sign", "BudgetCurrencyChar"]) ?? "");
    project.Country = String(getNestedValue(row, "owner_info.country.name")
        ?? getRowValue(row, ["owner_info.country.name", "Country", "country"])
        ?? "");
    project.Identity_verified = normalizeSheetFlag(getRowValue(row, [
        "owner_info.status.identity_verified", "Identity_verified", "identity_verified",
    ]));
    project.Payment_verified = normalizeSheetFlag(getRowValue(row, [
        "owner_info.status.payment_verified", "Payment_verified", "payment_verified",
    ]));
    project.Deposit_made = normalizeSheetFlag(getRowValue(row, [
        "owner_info.status.deposit_made", "Deposit_made", "deposit_made",
    ]));
    project.Email_verified = normalizeSheetFlag(getRowValue(row, [
        "owner_info.status.email_verified", "Email_verified", "email_verified",
    ]));
    project.Profile_completed = normalizeSheetFlag(getRowValue(row, [
        "owner_info.status.profile_complete", "Profile_completed", "profile_completed", "profile_complete",
    ]));
    project.Phone_verified = normalizeSheetFlag(getRowValue(row, [
        "owner_info.status.phone_verified", "Phone_verified", "phone_verified",
    ]));
    project.timeStamp = getRowValue(row, ["timestamp", "timeStamp", "Date/Time"]) ?? "";
    project.jobs = parseProjectJobs(row.jobs ?? row.job_details ?? "");

    Force_ProjectAnalyser(project);
    projectPlanner_PlanBid(project, planBidSettings);
    return project;
}

function getProjectIdentity(project) {
    return project.id || normalizeProjectHref(project.href);
}

function getNestedValue(item, path) {
    return path.split(".").reduce((value, key) => value?.[key], item);
}

async function getApiProjectDerivedFields(item) {
    const project = mapApiProjectRow(item);
    const planBid = project.PlanBid || "";
    const normalizedPlanBid = planBid === "Good" ? "good" : planBid;

    return {
        timestamp: getFormatedLocalTime(),
        plan_bid: normalizedPlanBid,
        min_budget_usd: project.MinBudget_USD,
        max_budget_usd: project.MaxBudget_USD,
        min_budget_group: project.MinBudgetGroup,
        max_budget_group: project.MaxBudgetGroup,
    };
}

const API_PROJECT_SOURCE_PATHS = {
    country: "owner_info.country.name",
    projecttype: "type",
    minbudget: "budget.minimum",
    currencycode: "currency.code",
    budgetcurrency: "currency.code",
    identityverified: "owner_info.status.identity_verified",
    paymentverified: "owner_info.status.payment_verified",
    depositmade: "owner_info.status.deposit_made",
    emailverified: "owner_info.status.email_verified",
    profilecompleted: "owner_info.status.profile_complete",
    profilecomplete: "owner_info.status.profile_complete",
    phoneverified: "owner_info.status.phone_verified",
};

function getApiProjectCellValue(item, header, derivedFields) {
    const normalizedHeader = String(header).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalizedHeader === "timestamp") return derivedFields.timestamp;
    if (normalizedHeader === "planbid") return derivedFields.plan_bid;
    if (normalizedHeader === "minbudgetusd") return derivedFields.min_budget_usd;
    if (normalizedHeader === "maxbudgetusd") return derivedFields.max_budget_usd;
    if (normalizedHeader === "minbudgetgroup") return derivedFields.min_budget_group;
    if (normalizedHeader === "maxbudgetgroup") return derivedFields.max_budget_group;

    const sourcePath = API_PROJECT_SOURCE_PATHS[normalizedHeader];
    if (sourcePath) {
        const sourceValue = getNestedValue(item, sourcePath) ?? item[sourcePath];
        if (sourceValue !== undefined && sourceValue !== null) return sourceValue;
    }

    const value = Object.prototype.hasOwnProperty.call(item, header)
        ? item[header]
        : header.includes(".")
            ? getNestedValue(item, header)
            : undefined;
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : value;
}

async function saveApiProjects(requestItems) {
    const projects = requestItems.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item) || !getProjectId(item)) {
            const error = new Error("Each API project must be an object with an id.");
            error.status = 400;
            throw error;
        }
        return item;
    });

    return withApiProjectsWriteLock(async () => {
        const idColumnIndex = getHeaderIndexByName(globalHeaders_API_Projects, ["id", "project_id", "projectId"]);
        if (idColumnIndex < 0) {
            throw new Error(`The ${API_PROJECTS_SHEET_NAME} sheet needs an id column for duplicate detection.`);
        }
        const idColumn = getColumnLetter_ABD(idColumnIndex);
        const client = await globalAuth.getClient();
        const sheets = google.sheets({ version: "v4", auth: client });
        const existingResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: globalSheetId,
            range: `${API_PROJECTS_SHEET_NAME}!${idColumn}2:${idColumn}`,
        });
        const existingIds = existingResponse.data.values || [];
        apiProjectsLastRow = Math.max(apiProjectsLastRow, existingIds.length + 1);
        for (const row of existingIds) {
            const existingId = String(row[0] ?? "").trim();
            if (existingId) knownApiProjectIds.add(existingId);
        }

        const batchIds = new Set();
        const newProjects = [];
        let duplicateCount = 0;
        for (const item of projects) {
            const id = getProjectId(item);
            if (knownApiProjectIds.has(id) || batchIds.has(id)) {
                duplicateCount++;
                continue;
            }
            batchIds.add(id);
            newProjects.push(item);
        }

        if (newProjects.length === 0) {
            return { savedCount: 0, duplicateCount };
        }

        const values = await Promise.all(newProjects.map(async item => {
            const derivedFields = await getApiProjectDerivedFields(item);
            return globalHeaders_API_Projects.map(header =>
                getApiProjectCellValue(item, header, derivedFields)
            );
        }));

        await sheets.spreadsheets.values.append({
            spreadsheetId: globalSheetId,
            range: `${API_PROJECTS_SHEET_NAME}!A1`,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            resource: { values },
        });

        for (const item of newProjects) {
            knownApiProjectIds.add(getProjectId(item));
        }
        apiProjectsLastRow = Math.max(apiProjectsLastRow, existingIds.length + newProjects.length + 1);

        return { savedCount: newProjects.length, duplicateCount };
    });
}
async function appendToSheet(sheetName, sheetHeaders, sheetHeaderIndexes, appendDataArray) {

    appendDataArray = appendDataArray.map(item => {
        for (const key in item) {
            if (item[key] === true) {
                item[key] = "Yes";
            } else if (item[key] === false) {
                item[key] = "No";
            }
        }
        return item;
    });

    //console.log("appendDataArray:", appendDataArray);
    const client = await globalAuth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });

    // Arrange data in the correct order
    const values = appendDataArray.map(obj => {
        let row = new Array(sheetHeaders.length).fill(""); // Create an empty array with the length of headers
        for (const key in obj) {
            if (sheetHeaderIndexes.hasOwnProperty(key)) {
                row[sheetHeaderIndexes[key]] = obj[key] ?? "";
            }
        }
        return row;
    });
    //console.log("values:", values);

    return await sheets.spreadsheets.values.append({
        spreadsheetId: globalSheetId,
        range: getSheetA1Range(sheetName, "A1"),
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        resource: { values },
    });
}

function setSheetValueByAlias(record, headers, aliases, value) {
    const headerIndex = getHeaderIndexByName(headers, aliases);
    if (headerIndex >= 0) {
        record[headers[headerIndex]] = value;
    }
}

async function appendMyEvents(eventInputs) {
    if (eventInputs.length === 0) return;
    const events = eventInputs.map(({
        dateTime = getFormatedLocalTime(),
        projectId = "",
        projectUrl = "",
        account,
        bidStatus,
        statusReason,
        proposal = "",
    }) => {
        const valuesByField = {
            "Date/Time": dateTime,
            "Project ID": projectId,
            "Project URL": projectUrl,
            Account: account,
            "Bid Status": bidStatus,
            "Status Reason": statusReason,
            Proposal: proposal,
        };
        const event = {};
        for (const field of MY_EVENTS_FIELDS) {
            const headerIndex = getHeaderIndexByName(globalHeaders_MyEvents, field.aliases);
            event[globalHeaders_MyEvents[headerIndex]] = valuesByField[field.key];
        }
        return event;
    });
    const result = await appendToSheet(
        MY_EVENTS_SHEET_NAME,
        globalHeaders_MyEvents,
        globalHeaderIndexes_MyEvents,
        events,
    );
    if (!result) {
        throw new Error(`Could not persist project events to ${MY_EVENTS_SHEET_NAME}.`);
    }
    for (const event of events) {
        indexAttemptedProject(event);
    }
    return result;
}

async function appendMyEvent(event) {
    return appendMyEvents([event]);
}


/**
 * Converts a number to an Excel-style column letter (0 -> A, 1 -> B, 26 -> AA).
 * @param {number} colIndex The 0-based column index.
 * @returns {string} The Excel column letter (e.g., "A", "B", "AA").
 */
function getColumnLetter_ABD(colIndex) {
    let temp, letter = '';
    // Adjust 0-based index for 1-based calculation (+1), but handled as colIndex >= 0 in logic.
    let num = colIndex + 1;
    while (num > 0) {
        temp = (num - 1) % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        num = Math.floor((num - 1) / 26);
    }
    return letter;
}


//////////////////////////////////////////////

let hrefArray = [];
function cloneRemover(appendDataArray) {
    const filteredDataArray = appendDataArray.filter(obj => {
        if (!obj.href || hrefArray.includes(obj.href)) {
            return false; // Remove the object
        } else {
            hrefArray.push(obj.href);
            return true; // Keep the object
        }
    });
    return filteredDataArray;  // Return the new filtered array
}

const HREFARRAYSIZEMAX = 200;
const HREFARRAYSIZE = 100;

const DATAARRAYSIZEMAX = 80;
const DATAARRAYSIZE = 50;

const DETAILTRYCOUNTMAX = 3;
const processedDetailIds = new Set();

function getDetailValue(item, path, fallback = "") {
    const value = path.split(".").reduce((current, key) => current?.[key], item);
    return value === undefined || value === null ? fallback : value;
}

function mapDetailItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
    }

    const mappedItem = {
        title: getDetailValue(item, "title"),
        href: getDetailValue(item, "seo_url"),
        ProjectTitle: getDetailValue(item, "title"),
        ProjectBudget: "",
        ProjectType: getDetailValue(item, "type"),
        BudgetCurrencyChar: getDetailValue(item, "currency.sign"),
        BudgetCurrency: getDetailValue(item, "currency.code", getDetailValue(item, "BudgetCurrency")),
        MinBudget: getDetailValue(item, "budget.minimum"),
        MaxBudget: getDetailValue(item, "budget.maximum"),
        ProjectDescription: getDetailValue(item, "description"),
        Location: "",
        Country: "",
        Star: "",
        Member: "",
        MemberDayOld: "",
        Review: "",
        Identity_verified: getDetailValue(item, "owner_info.status.identity_verified"),
        Payment_verified: getDetailValue(item, "owner_info.status.payment_verified"),
        Deposit_made: getDetailValue(item, "owner_info.status.deposit_made"),
        Email_verified: getDetailValue(item, "owner_info.status.email_verified"),
        Profile_completed: getDetailValue(item, "owner_info.status.profile_complete"),
        Phone_verified: getDetailValue(item, "owner_info.status.phone_verified"),
        Prefered: "",
        IPA: "",
        NDA: getDetailValue(item, "upgrades.NDA"),
        Restricted: "",
        Australian: "",
        CategoryName: "",
        CategoryScore: ""
    };

    if (typeof mappedItem.href !== "string" || mappedItem.href.trim() === "") {
        return null;
    }
    mappedItem.href = mappedItem.href.trim();
    return mappedItem;
}

function normalizeProjectHref(href) {
    if (typeof href !== "string") {
        return "";
    }

    let pathname = href.trim();
    try {
        pathname = new URL(pathname, "https://www.freelancer.com").pathname;
    } catch {
        return "";
    }

    return pathname
        .replace(/^\/projects\//i, "/")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
}

function deduplicateDetailItems(items) {
    const uniqueItems = [];
    const requestIds = new Set();
    const reservedIds = [];
    let duplicateCount = 0;

    for (const item of items) {
        const id = item && (typeof item.id === "string" || typeof item.id === "number")
            ? String(item.id).trim()
            : "";
        if (id === "") {
            console.warn("Skipping invalid detail item: expected an object with a non-empty id and href.");
            continue;
        }
        if (requestIds.has(id) || processedDetailIds.has(id)) {
            duplicateCount++;
            continue;
        }

        const mappedItem = mapDetailItem(item);
        if (!mappedItem) {
            console.warn("Skipping invalid detail item: expected an object with a non-empty id and href.");
            continue;
        }

        requestIds.add(id);
        processedDetailIds.add(id);
        reservedIds.push(id);
        uniqueItems.push(mappedItem);
    }

    return { uniqueItems, reservedIds, duplicateCount };
}

function cacheCheck() {

    if (hrefArray.length > HREFARRAYSIZEMAX) {
        console.log(`Trimming hrefArray: Original size ${hrefArray.length}, trimming to last ${HREFARRAYSIZE}`);
        hrefArray = hrefArray.slice(-HREFARRAYSIZE);
    }

    if (projectDataArray.length > DATAARRAYSIZEMAX) {
        console.log(`Trimming projectDataArray: Original size ${projectDataArray.length}, trimming to last ${DATAARRAYSIZE}`);
        projectDataArray = projectDataArray.slice(-DATAARRAYSIZE);
    }


    const originalLength = projectDataArray.length;
    // Remove items from projectDataArray if __detailTryCount exceeds DETAILTRYCOUNTMAX
    projectDataArray = projectDataArray.filter(item => {
        return !(item.__detailTryCount && item.__detailTryCount >= DETAILTRYCOUNTMAX);
    }); 
    const filteredLength = projectDataArray.length;
    if (originalLength > filteredLength) {
        console.log(`Filtered projectDataArray: Removed ${originalLength - filteredLength} items.`);
    }
}






async function projectCollector_A(appendDataArray) {
    appendDataArray = cloneRemover(appendDataArray); // Remove duplicates

    const registeredAt = getFormatedLocalTime();
    appendDataArray = appendDataArray.map(item => ({ ...item, timeStamp: registeredAt }));

    appendDataArray.reverse(); // Reverse the array

    

    if (appendDataArray.length === 0) {
        //console.log("No new data to append. hrefArray size:", hrefArray.size);
        return;
    }

    console.log(`+appendDataArray.length:${appendDataArray.length}\t`, `projectDataArray.length:${projectDataArray.length}\t`, `hrefArray.length:${hrefArray.length}`);
//    appendDataArray.forEach(item => {
//        console.log(`\t+ Title: ${item.title},\t Href: ${item.href}`);
//    });

    projectDataArray = projectDataArray.concat(appendDataArray);
}

let projectDataArray=[];

async function projectCollector_B(detailDataArray) {
    for (let i = 0; i < detailDataArray.length; i++) {
        const detailItem = detailDataArray[i];
        const detailHref = normalizeProjectHref(detailItem.href);
        const matchingIndex = projectDataArray.findIndex(existingItem =>
            normalizeProjectHref(existingItem.href) === detailHref
        );
    
        if (matchingIndex !== -1) {
            detailItem.timeStamp = projectDataArray[matchingIndex].timeStamp; // Add timeStamp
            projectDataArray.splice(matchingIndex, 1); // Remove the matching item from projectDataArray
        } else {
            console.warn("Strange Warning Key Error:", detailItem['ProjectTitle'], detailItem.href);
            detailItem.timeStamp = `${getFormatedLocalTime()}`;
        }
    
        //
        detailDataArray[i] = detailItem;
    }
    
    for (let i = 0; i < detailDataArray.length; i++) {
        let detailItem = detailDataArray[i];
        //console.log("before Force_ProjectAnalyser:", detailItem);

        //console.log("After Force_ProjectAnalyser:", detailItem);

        detailItem = projectPlanner_PlanBid(detailItem); // Run projectPlanner_PlanBid on the item
        //console.log("After projectPlanner_PlanBid:", detailItem);

        //console.log("After proposalMaker:", detailItem);

        //console.log("After projectPlanner_Conclusion:", detailItem);

        detailDataArray[i] = detailItem; // 
    }


    console.log(`-detailDataArray.length:${detailDataArray.length}\t`, `projectDataArray.length:${projectDataArray.length}\t`, `hrefArray.length:${hrefArray.length}`);

//    detailDataArray.forEach(item => {
//        console.log(`\t- Title: ${item['ProjectTitle']},\t Href: ${item.href}`);
//    });




    // console.log("sheet name:",PROJECTS_SHEET_NAME);
    // console.log('globalhearders_projects:', globalHeaders_Projects)
    // console.log('globalHeaderIndexes_Projects:', globalHeaderIndexes_Projects);
    // console.log('detaildataArray:',detailDataArray);


}

// Data addition endpoint
app.post("/add", async (req, res) => {
    //console.log("Received data:", req.body);
    try {
        let values = req.body; // Data sent from the extension or test page
        if (!values || !Array.isArray(values)) {
            return res.status(400).json({ error: "Invalid data format" });
        }
        await projectCollector_A(values);
        res.json({ message: "Data added successfully" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

const HREFPERREQUEST = 1;
let autoFetchActive = false;
let autoFetchTimer = null;
let autoFetchCyclePromise = null;
let projectFetchPromise = null;

async function handleDetailAdd(req, res) {
    try {
        const projects = Array.isArray(req.body)
            ? req.body
            : req.body?.result?.projects ?? req.body?.projects;
        if (!Array.isArray(projects)) {
            return res.status(400).json({
                error: "Invalid data format",
                expected: "An array of projects or an object containing result.projects",
            });
        }

        const result = await processDetailProjects(projects);
        res.json(result.detailHrefs);
    } catch (error) {
        console.error(error);
        res.status(error.status || 500).json({
            error: error.status === 400 ? error.message : "Internal Server Error",
        });
    }
}

async function handleFetchProjects(_req, res) {
    try {
        const result = await fetchAndProcessProjects();
        res.json({ ok: true, ...result });
    } catch (error) {
        sendFetchError(res, error);
    }
}

function handleStartAutoFetch(_req, res) {
    if (autoFetchActive) {
        return res.json({
            ok: true,
            active: true,
            message: "Server-side auto-fetch is already running.",
        });
    }

    autoFetchActive = true;
    void runAutoFetchCycle();
    return res.json({
        ok: true,
        active: true,
        message: "Server-side auto-fetch started. The server will check every 10 seconds.",
    });
}

function handleStopAutoFetch(_req, res) {
    autoFetchActive = false;
    if (autoFetchTimer) {
        clearTimeout(autoFetchTimer);
        autoFetchTimer = null;
    }
    return res.json({
        ok: true,
        active: false,
        message: "Server-side auto-fetch stopped.",
    });
}

function fetchAndProcessProjects() {
    if (projectFetchPromise) return projectFetchPromise;

    projectFetchPromise = performFetchAndProcessProjects().finally(() => {
        projectFetchPromise = null;
    });
    return projectFetchPromise;
}

async function performFetchAndProcessProjects() {
    const projectsUrl =
        "https://www.freelancer.com/api/projects/0.1/projects/active?limit=20&full_description=true&job_details=true&local_details=true&location_details=true&upgrade_details=true&owner_info=true&languages%5B%5D=en&sort_field=submitdate&webapp=1&compact=true&new_errors=true&new_pools=true";

    const freelancerResponse = await fetch(projectsUrl, {
        headers: { Accept: "application/json" },
    });

    if (!freelancerResponse.ok) {
        const error = new Error(`Freelancer returned HTTP ${freelancerResponse.status}.`);
        error.status = 502;
        throw error;
    }

    let projectData;
    try {
        projectData = await freelancerResponse.json();
    } catch {
        const error = new Error("Freelancer returned a response that was not valid JSON.");
        error.status = 502;
        throw error;
    }

    const projects = projectData?.result?.projects;
    if (!Array.isArray(projects)) {
        const error = new Error("Freelancer response did not contain a result.projects array.");
        error.status = 502;
        throw error;
    }

    const { savedCount, duplicateCount, detailHrefs } =
        await processDetailProjects(projects);
    return {
        message: `Fetched ${projects.length} projects; saved ${savedCount} new projects and skipped ${duplicateCount} duplicates.`,
        projects,
        savedCount,
        duplicateCount,
        detailHrefs,
    };
}

function sendFetchError(res, error) {
    console.error("Failed to fetch or process Freelancer projects:", error);
    res.status(error.status || 502).json({
        ok: false,
        error: error.status === 400
            ? error.message
            : `Could not fetch or process Freelancer projects: ${error.message}`,
    });
}

function runAutoFetchCycle() {
    if (!autoFetchActive || autoFetchCyclePromise) return autoFetchCyclePromise;

    autoFetchCyclePromise = (async () => {
        try {
            const result = await fetchAndProcessProjects();
            console.log(`Server-side auto-fetch: ${result.message}`);
        } catch (error) {
            console.error("Server-side auto-fetch failed:", error);
        }
    })().finally(() => {
        autoFetchCyclePromise = null;
        if (autoFetchActive) {
            autoFetchTimer = setTimeout(() => {
                autoFetchTimer = null;
                void runAutoFetchCycle();
            }, PROJECT_POLL_INTERVAL_MS);
        }
    });

    return autoFetchCyclePromise;
}

async function processDetailProjects(projects) {
    const { savedCount, duplicateCount } = await saveApiProjects(projects);
    console.log(`API_projects saved: ${savedCount}; duplicates skipped: ${duplicateCount}`);
    for (const item of projects) {
        const href = item && (item.seo_url ?? item.href);
        const matchingIndex = projectDataArray.findIndex(project =>
            normalizeProjectHref(project.href) === normalizeProjectHref(href)
        );
        if (matchingIndex >= 0) {
            projectDataArray.splice(matchingIndex, 1);
        }
    }
    cacheCheck();

    const detailHrefs = projectDataArray.slice(-HREFPERREQUEST).map(item => {
        item.__detailTryCount = (item.__detailTryCount || 0) + 1;
        return item.href;
    }).reverse();

    return { savedCount, duplicateCount, detailHrefs };
}

app.post("/add_detail", handleDetailAdd);

// Start server
try {
    await initializeHeaderIndexes();
    await initializeProjectSelectionState();
    app.listen(PORT, HOST, () => console.log(`Server running on ${HOST}:${PORT}`));
} catch (error) {
    console.error("Failed to initialize header indexes:", error);
    //process.exit(1);
}

let alarmsData={};

app.post('/alarm', async (req, res) => {
    let alarm = req.body;
    //console.log('alarm posted:', alarm);
    if (!alarm['username'] || alarm['username'].trim() === "" || alarm['username'] === 'unknown') {
        console.error("Error: 'username' error alarm:", alarm.toString());
        return res.status(400).json({ error: "'username' is required" });
    }

    if (!(JSON.stringify(alarmsData[alarm['username']]) === JSON.stringify(alarm))) {
        await updateSheet(alarm);
    }
    

    alarmsData[alarm['username']] = alarm; // Update the alarmsData with the latest alarm
    res.json({ message: "Alarm processed successfully" });
});


/**
 * Adds or updates a row in the specified Google Sheet ("Alarms").
 * Finds the row based on the 'username' key in the input object.
 * If a row with the username exists, it updates the row.
 * If not, it appends a new row.
 * Keys in the alarm object that don't match header columns are ignored.
 *
 * @param {object} alarm - An object representing a row. Keys are column names, values are cell values. Must contain a 'username' key.
 * @returns {Promise<object|null>} A promise that resolves with the result from the Sheets API update/append call, or null if an error occurs.
 */
async function updateSheet(alarm) {
    //console.log('updateSheet:', alarm);
    if (!alarm || typeof alarm !== 'object') {
        console.error("Invalid input: 'alarm' parameter must be an object.");
        return null;
    }
    if (!alarm.username) {
        console.error("Invalid input: 'alarm' object must contain a 'username' key.");
        return null;
    }

    try {
        const sheets = google.sheets({ version: 'v4', auth });

        const dataResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${ALARM_SHEET_NAME}!A:Z`, // Read full range from column A to Z (expand if needed)
            // valueRenderOption: 'UNFORMATTED_VALUE' // Optional: use this if you want raw values
        });
        
        const allRows = dataResponse.data.values || [];
        if (allRows.length === 0) {
            console.error(`Sheet "${ALARM_SHEET_NAME}" is empty.`);
            return null;
        }
        
        // 1. Extract header row from the first row
        const headerRow = allRows[0];
        const headerMap = new Map();
        headerRow.forEach((colName, index) => {
            if (colName) {
                headerMap.set(colName.trim(), index);
            }
        });
        
        // 2. Check if 'username' column exists
        const usernameColIndex = headerMap.get("username");
        if (usernameColIndex === undefined) {
            console.error(`Column "username" not found in the header of sheet "${ALARM_SHEET_NAME}".`);
            return null;
        }
        
        // 3. Find the row index matching the target username
        let targetRowIndex = -1; // Sheet row index (1-based)
        for (let i = 1; i < allRows.length; i++) {
            const row = allRows[i];
            if (row && row.length > usernameColIndex && row[usernameColIndex] === alarm.username) {
                targetRowIndex = i + 1; // +1 because sheet rows are 1-based
                break;
            }
        }
        
        // 4. Create a row of data in the correct column order based on the header
        const outputRow = new Array(headerRow.length).fill('');
        for (const [colName, index] of headerMap.entries()) {
            if (alarm.hasOwnProperty(colName)) {
                outputRow[index] = alarm[colName] !== null && alarm[colName] !== undefined ? alarm[colName] : '';
            }
        }
        
        // 5. Update the existing row or append a new one
        let result;
        if (targetRowIndex > 0) {
            // --- UPDATE existing row ---
            const updateRange = `${ALARM_SHEET_NAME}!A${targetRowIndex}:${String.fromCharCode(65 + headerRow.length - 1)}${targetRowIndex}`;
            console.log(`Updating row ${targetRowIndex} for username: ${alarm.username}`, outputRow);
            result = await sheets.spreadsheets.values.update({
                spreadsheetId: SHEET_ID,
                range: updateRange,
                valueInputOption: "USER_ENTERED",
                resource: {
                    values: [outputRow],
                },
            });
        } else {
            // --- APPEND new row ---
            const appendRange = `${ALARM_SHEET_NAME}!A:A`; // Appends to the sheet starting from column A
            console.log(`Appending new row for username: ${alarm.username}`, outputRow);
            result = await sheets.spreadsheets.values.append({
                spreadsheetId: SHEET_ID,
                range: appendRange,
                valueInputOption: "USER_ENTERED",
                insertDataOption: "INSERT_ROWS",
                resource: {
                    values: [outputRow],
                },
            });
        }
        
        return result.data;
        


/**        
        const sheets = google.sheets({ version: 'v4', auth });

        // 1. Get Header Row to map column names to indices
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${ALARM_SHEET_NAME}!1:1`, // Read the first row
        });

        const headerRow = headerResponse.data.values ? headerResponse.data.values[0] : [];
        if (!headerRow || headerRow.length === 0) {
            console.error(`Sheet "${ALARM_SHEET_NAME}" is empty or header row could not be read.`);
            return null;
        }

        // Create a map: { columnName: index }
        const headerMap = new Map();
        headerRow.forEach((colName, index) => {
            if (colName) { // Handle potentially empty header cells
                headerMap.set(colName.trim(), index);
            }
        });

        // Check if 'username' column exists
        const usernameColIndex = headerMap.get("username");
        if (usernameColIndex === undefined) {
            console.error(`Column "username" not found in the header of sheet "${ALARM_SHEET_NAME}".`);
            return null;
        }

        // 2. Get all data to find the row with the matching username
        const dataResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${ALARM_SHEET_NAME}!A:${String.fromCharCode(65 + headerRow.length - 1)}`, // Read all data within header bounds
            // valueRenderOption: 'UNFORMATTED_VALUE' // Consider if you need raw values
        });

        const allRows = dataResponse.data.values || [];
        let targetRowIndex = -1; // Sheet row index (1-based)

        // Start searching from the second row (index 1) as first row (index 0) is header
        for (let i = 1; i < allRows.length; i++) {
            const row = allRows[i];
            // Ensure row has enough columns and the username matches
            if (row && row.length > usernameColIndex && row[usernameColIndex] === alarm.username) {
                targetRowIndex = i + 1; // +1 because sheet rows are 1-based
                break;
            }
        }

        // 3. Prepare the data row in the correct order based on the header
        const outputRow = new Array(headerRow.length).fill(''); // Initialize with empty strings
        for (const [colName, index] of headerMap.entries()) {
            if (alarm.hasOwnProperty(colName)) {
                // Handle different data types if necessary, Sheets API usually handles basic ones
                outputRow[index] = alarm[colName] !== null && alarm[colName] !== undefined ? alarm[colName] : '';
            }
            // If alarm doesn't have the key, it remains an empty string (or its default value)
        }

        // 4. Perform Update or Append
        let result;
        if (targetRowIndex > 0) {
            // --- UPDATE existing row ---
            const updateRange = `${ALARM_SHEET_NAME}!A${targetRowIndex}:${String.fromCharCode(65 + headerRow.length - 1)}${targetRowIndex}`;
            console.log(`Updating row ${targetRowIndex} for username: ${alarm.username},${outputRow}`);
            result = await sheets.spreadsheets.values.update({
                spreadsheetId: SHEET_ID,
                range: updateRange,
                valueInputOption: "USER_ENTERED", // Or 'RAW' if you don't want interpretation
                resource: {
                    values: [outputRow], // Needs to be an array of arrays
                },
            });
            //console.log("Update result:", result.data);

        } else {
            // --- APPEND new row ---
             // Append starting from column A of the sheet
            const appendRange = `${ALARM_SHEET_NAME}!A:A`;
            console.log(`Appending new row for username: ${alarm.username},${outputRow}`);
            result = await sheets.spreadsheets.values.append({
                spreadsheetId: SHEET_ID,
                range: appendRange, // Specifies the sheet/table to append to
                valueInputOption: "USER_ENTERED", // Or 'RAW'
                insertDataOption: "INSERT_ROWS", // Important: inserts new rows
                resource: {
                    values: [outputRow], // Needs to be an array of arrays
                },
            });
            //console.log("Append result:", result.data);
        }

        return result.data; // Return the response data from the API
**/
    } catch (err) {
        console.error("Error interacting with Google Sheets API:", err.message);
        // Log more details if available, e.g., err.response?.data
        if (err.response && err.response.data && err.response.data.error) {
             console.error("API Error Details:", JSON.stringify(err.response.data.error, null, 2));
        } else if (err.errors) {
             console.error("API Error Array:", JSON.stringify(err.errors, null, 2));
        }
        return null; // Indicate failure
    }
}





///////////////////////////////////Auto Bidder
const reservedProjectsByUser = new Map();
const RESERVATION_TTL_MS = 10 * 60 * 1000;

function reserveProject(username, projectIdentity) {
    const now = Date.now();
    let reservations = reservedProjectsByUser.get(username);
    if (!reservations) {
        reservations = new Map();
        reservedProjectsByUser.set(username, reservations);
    }

    for (const [identity, reservedAt] of reservations) {
        if (now - reservedAt > RESERVATION_TTL_MS) {
            reservations.delete(identity);
        }
    }
    if (reservations.has(projectIdentity)) return false;

    reservations.set(projectIdentity, now);
    return true;
}

function releaseProject(username, projectIdentity) {
    const reservations = reservedProjectsByUser.get(username);
    if (!reservations) return;
    reservations.delete(projectIdentity);
    if (reservations.size === 0) {
        reservedProjectsByUser.delete(username);
    }
}

function isPlanBidCandidate(project) {
    const planBidValue = project?.plan_bid ?? project?.PlanBid ?? project?.planBid ?? "";
    return String(planBidValue).trim().toLowerCase() === "good";
}

function getPlanBidSkipReason(project) {
    const reasons = {
        Bad_Prefered: "Project was excluded by the existing preferred-project rule.",
        Bad_Verify: "Client verification requirements were not met.",
        Bad_Country: `Client country "${project.Country || "unknown"}" is in the excluded-country list.`,
        Bad_over50pHr: "Hourly minimum budget reached or exceeded the configured cutoff.",
        Bad_over2500: "Fixed-project minimum budget reached or exceeded the configured cutoff.",
        Bad_Currency: "Project currency is missing or unsupported.",
    };
    const reasonCode = project.PlanBid || project.plan_bid || "not Good";
    return reasons[reasonCode] || `PlanBid filter excluded this project (${reasonCode}).`;
}

function getProjectAgeSkipReason(project) {
    const registeredAt = project.timeStamp;
    const registeredAtMs = parseJstTimestamp(registeredAt);
    if (registeredAtMs === null) {
        return "Project registration timestamp is missing or invalid; it cannot be verified as newer than 24 hours.";
    }

    const ageMs = Date.now() - registeredAtMs;
    if (ageMs < 0) {
        return "Project registration timestamp is in the future; it cannot be verified as eligible.";
    }
    if (!isProjectRegisteredWithinLast24Hours(registeredAt)) {
        return `Project was registered ${(ageMs / (60 * 60 * 1000)).toFixed(1)} hours ago, `
            + "outside the 24-hour eligibility window.";
    }
    return "";
}

async function selectProject_ABD(userInfo) {
    const username = String(userInfo.username ?? "").trim();
    if (!username) {
        const error = new Error("username is required.");
        error.status = 400;
        throw error;
    }
    return withSelectionLock(username, async () => {
        const profile = await getUserProfile(username);
        const planBidSettings = normalizePlanBidSettings(userInfo.planBidSettings);
        const feasibilitySettings = normalizeFeasibilitySettings(userInfo.planBidSettings);
        const cursor = getSelectionCursor(username);

        if (cursor.pendingRow !== null) {
            const [pendingProject] = await readSheetRowsRange(
                API_PROJECTS_SHEET_NAME,
                globalHeaders_API_Projects,
                cursor.pendingRow,
                cursor.pendingRow,
            );
            if (pendingProject) {
                const project = mapApiProjectRow(pendingProject, planBidSettings);
                if (project.id && project.href && !hasAttemptedProject(username, project)) {
                    const ageSkipReason = getProjectAgeSkipReason(project);
                    if (ageSkipReason) {
                        await appendMyEvent({
                            projectId: project.id,
                            projectUrl: project.href,
                            account: username,
                            bidStatus: "Skip",
                            statusReason: ageSkipReason,
                        });
                    } else {
                        const cachedProposal = pendingProposalsByUser.get(normalizeUsername(username));
                        if (cachedProposal) return cachedProposal;

                        project.matchedSkills = getMatchedSkills(project.jobs, profile.skills);
                        if (project.matchedSkills.length >= feasibilitySettings.minimumSkillMatches) {
                            const assessment = await evaluateProjectFeasibility(project, profile);
                            if (assessment.score >= feasibilitySettings.minimumFeasibilityScore) {
                                project.FeasibilityScore = assessment.score;
                                project.FeasibilityReasoning = assessment.reasoning;
                                const proposal = await generateProjectProposal(project, username, profile);
                                if (proposal) {
                                    pendingProposalsByUser.set(normalizeUsername(username), proposal);
                                    return proposal;
                                }
                            } else {
                                await appendMyEvent({
                                    projectId: project.id,
                                    projectUrl: project.href,
                                    account: username,
                                    bidStatus: "Skip",
                                    statusReason: `Feasibility score ${assessment.score} was below threshold `
                                        + `${feasibilitySettings.minimumFeasibilityScore}. ${assessment.reasoning}`,
                                });
                            }
                        } else {
                            await appendMyEvent({
                                projectId: project.id,
                                projectUrl: project.href,
                                account: username,
                                bidStatus: "Skip",
                                statusReason: `Required-skill filter matched ${project.matchedSkills.length} skill(s); `
                                    + `${feasibilitySettings.minimumSkillMatches} required.`,
                            });
                        }
                    }
                }
            }
            cursor.pendingRow = null;
            cursor.pendingProjectId = "";
            pendingProposalsByUser.delete(normalizeUsername(username));
            saveSelectionCursors();
        }

        while (cursor.nextRow <= apiProjectsLastRow) {
            const startRow = cursor.nextRow;
            const endRow = Math.min(startRow + 99, apiProjectsLastRow);
            const rows = await readSheetRowsRange(
                API_PROJECTS_SHEET_NAME,
                globalHeaders_API_Projects,
                startRow,
                endRow,
            );
            const expiredProjectEvents = [];

            for (let index = 0; index < rows.length; index++) {
                const rowNumber = startRow + index;
                const project = mapApiProjectRow(rows[index], planBidSettings);
                if (!project.id || !project.href) {
                    cursor.nextRow = rowNumber + 1;
                    continue;
                }

                if (hasAttemptedProject(username, project)) {
                    cursor.nextRow = rowNumber + 1;
                    continue;
                }

                const ageSkipReason = getProjectAgeSkipReason(project);
                if (ageSkipReason) {
                    expiredProjectEvents.push({
                        projectId: project.id,
                        projectUrl: project.href,
                        account: username,
                        bidStatus: "Skip",
                        statusReason: ageSkipReason,
                    });
                    cursor.nextRow = rowNumber + 1;
                    saveSelectionCursors();
                    continue;
                }

                if (!isPlanBidCandidate(project)) {
                    await appendMyEvent({
                        projectId: project.id,
                        projectUrl: project.href,
                        account: username,
                        bidStatus: "Skip",
                        statusReason: getPlanBidSkipReason(project),
                    });
                    cursor.nextRow = rowNumber + 1;
                    saveSelectionCursors();
                    continue;
                }

                project.matchedSkills = getMatchedSkills(project.jobs, profile.skills);
                if (project.matchedSkills.length < feasibilitySettings.minimumSkillMatches) {
                    await appendMyEvent({
                        projectId: project.id,
                        projectUrl: project.href,
                        account: username,
                        bidStatus: "Skip",
                        statusReason: `Required-skill filter matched ${project.matchedSkills.length} skill(s); `
                            + `${feasibilitySettings.minimumSkillMatches} required.`
                            + (project.matchedSkills.length
                                ? ` Matched: ${project.matchedSkills.join(", ")}.`
                                : ""),
                    });
                    cursor.nextRow = rowNumber + 1;
                    saveSelectionCursors();
                    continue;
                }

                const projectIdentity = getProjectIdentity(project);
                if (!reserveProject(normalizeUsername(username), projectIdentity)) {
                    cursor.nextRow = rowNumber + 1;
                    continue;
                }

                try {
                    const assessment = await evaluateProjectFeasibility(project, profile);
                    if (assessment.score < feasibilitySettings.minimumFeasibilityScore) {
                        releaseProject(normalizeUsername(username), projectIdentity);
                        await appendMyEvent({
                            projectId: project.id,
                            projectUrl: project.href,
                            account: username,
                            bidStatus: "Skip",
                            statusReason: `Feasibility score ${assessment.score} was below threshold `
                                + `${feasibilitySettings.minimumFeasibilityScore}. ${assessment.reasoning}`,
                        });
                        cursor.nextRow = rowNumber + 1;
                        console.log(
                            `Project ${project.id} was below the feasibility threshold: ${assessment.score}.`
                        );
                        saveSelectionCursors();
                        continue;
                    }
                    project.FeasibilityScore = assessment.score;
                    project.FeasibilityReasoning = assessment.reasoning;
                    const proposal = await generateProjectProposal(project, username, profile);
                    if (!proposal) {
                        cursor.nextRow = rowNumber + 1;
                        cursor.pendingRow = null;
                        cursor.pendingProjectId = "";
                        saveSelectionCursors();
                        continue;
                    }
                    cursor.nextRow = rowNumber + 1;
                    cursor.pendingRow = rowNumber;
                    cursor.pendingProjectId = project.id;
                    pendingProposalsByUser.set(normalizeUsername(username), proposal);
                    await appendMyEvents(expiredProjectEvents);
                    saveSelectionCursors();
                    return proposal;
                } catch (error) {
                    await appendMyEvents(expiredProjectEvents);
                    releaseProject(normalizeUsername(username), projectIdentity);
                    cursor.nextRow = rowNumber;
                    saveSelectionCursors();
                    throw error;
                }
            }

            await appendMyEvents(expiredProjectEvents);
            cursor.nextRow = endRow + 1;
            saveSelectionCursors();
        }
        return null;
    });
}

async function generateProjectProposal(project, username, profile) {
    const proposal = await proposalMaker(
        project,
        undefined,
        profile.aboutMe,
        profile.skills,
        profile.prompt,
        profile.geminiApiKey
    );
    if (!proposal || typeof proposal.ProposalText !== "string" || proposal.ProposalText.trim() === "") {
        throw new Error(`Gemini returned no proposal text for project ${project.id}.`);
    }
    if (proposal.ProposalBudget === undefined || proposal.ProposalTime === undefined) {
        throw new Error(`Gemini returned an incomplete proposal for project ${project.id}.`);
    }
    proposal.username = username;
    proposal.FeasibilityScore = project.FeasibilityScore;
    proposal.FeasibilityReasoning = project.FeasibilityReasoning;
    proposal.MatchedSkills = project.matchedSkills;
    return proposal;
}





// Data addition endpoint
app.post("/bid_attempt", (req, res) => {
    const account = String(req.body?.account ?? req.body?.username ?? "").trim();
    const projectId = String(req.body?.project_id ?? req.body?.projectId ?? "").trim();
    const projectUrl = String(req.body?.project_url ?? req.body?.href ?? "").trim();
    const proposal = req.body?.proposal ?? req.body?.bid;
    if (!account || !projectId || !projectUrl || typeof proposal !== "string" || !proposal.trim()) {
        return res.status(400).json({
            error: "account, project_id, project_url, and proposal are required to register a bid attempt.",
        });
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(projectUrl);
    } catch {
        return res.status(400).json({ error: "project_url must be a valid Freelancer project URL." });
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "www.freelancer.com") {
        return res.status(400).json({ error: "project_url must be an HTTPS Freelancer project URL." });
    }

    const now = Date.now();
    for (const [attemptId, attempt] of bidAttemptsById) {
        if (now - attempt.createdAtMs > 60 * 60 * 1000) {
            bidAttemptsById.delete(attemptId);
        }
    }

    const attemptId = randomUUID();
    const attemptedAt = formatJstDateTime(new Date(now));
    bidAttemptsById.set(attemptId, {
        account,
        projectId,
        projectUrl,
        proposal,
        attemptedAt,
        createdAtMs: now,
    });
    return res.json({ attemptId, attemptedAt });
});

app.post("/bid_result", async (req, res) => {
    try {
        const body = req.body;
        const attemptId = String(body?.attemptId ?? "").trim();
        const attempt = bidAttemptsById.get(attemptId);
        if (!attempt) {
            return res.status(400).json({
                error: "A valid attemptId from /bid_attempt is required.",
            });
        }

        const username = attempt.account;
        const projectId = attempt.projectId;
        const succeeded = body?.result === true
            || ["yes", "true", "success"].includes(String(body?.result ?? body?.status ?? "").trim().toLowerCase());
        const statusReason = String(body?.reason ?? "").trim()
            || (succeeded ? "Bid success was confirmed by the extension." : "Bid was not confirmed by the extension.");
        await appendMyEvent({
            dateTime: attempt.attemptedAt,
            projectId,
            projectUrl: attempt.projectUrl,
            account: username,
            bidStatus: succeeded ? "Yes" : "Error",
            statusReason,
            proposal: attempt.proposal,
        });

        const cursor = selectionCursors[normalizeUsername(username)];
        if (cursor && cursor.pendingProjectId === projectId) {
            cursor.pendingRow = null;
            cursor.pendingProjectId = "";
            pendingProposalsByUser.delete(normalizeUsername(username));
            saveSelectionCursors();
        }
        releaseProject(normalizeUsername(username), projectId || normalizeProjectHref(attempt.projectUrl));
        bidAttemptsById.delete(attemptId);
        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(error.status || 500).json({ error: error.message || "Could not store bid result." });
    }
});


// Data addition endpoint
app.post("/need_project", async (req, res) => {
    try {
        const body = req.body;
        const username = String(body?.username ?? "").trim();
        if (!username) {
            return res.status(400).json({ error: "username is required." });
        }
        const userInfo = {
            ...body,
            username,
        };
        const selected_project = await selectProject_ABD(userInfo);

        if (selected_project) {
            console.log(`Selected API project ${selected_project.id} for username ${username}: ${selected_project.ProjectTitle}`);
        }
        res.json(selected_project);
    } catch (error) {
        console.error(error);
        res.status(error.status || 500).json({ error: error.message || "Could not select a project." });
    }
});
