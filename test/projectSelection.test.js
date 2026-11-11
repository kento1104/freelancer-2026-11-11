import assert from "node:assert/strict";
import test from "node:test";

import Force_ProjectAnalyser, {
    getBudgetCurrencyCode,
} from "../_works/_codes/Force_ProjectAnalyser.js";
import projectPlanner_PlanBid from "../_works/_codes/projectPlanner_PlanBid.js";
import { parseFeasibilityAssessment } from "../_works/_codes/projectFeasibilityEvaluator.js";
import {
    getMatchedSkills,
    normalizeFeasibilitySettings,
    parseProjectJobs,
} from "../_works/_codes/projectSkills.js";
import {
    formatJstDateTime,
    isProjectRegisteredWithinLast24Hours,
    parseJstTimestamp,
} from "../_works/_codes/_toolkit/getFormatedLocalTime.js";
import { AVAILABLE_COUNTRIES } from "../../auto bid/countryNames.js";

test("parses Freelancer job objects and matches exact profile skills case-insensitively", () => {
    const jobs = parseProjectJobs(JSON.stringify([
        { id: 52, name: "Video Services" },
        { id: 688, name: "Video Editing" },
        { id: 2075, name: "Content Creation" },
    ]));

    assert.deepEqual(
        getMatchedSkills(jobs, "video services, VIDEO EDITING, writing"),
        ["Video Services", "Video Editing"],
    );
});

test("does not count duplicate job skills more than once", () => {
    assert.deepEqual(
        getMatchedSkills(["JavaScript", " javascript ", "Java"], "javascript, java"),
        ["javascript", "Java"],
    );
});

test("normalizes the skill-match and 10-point feasibility thresholds", () => {
    assert.deepEqual(
        normalizeFeasibilitySettings({
            minimumSkillMatches: "3",
            minimumFeasibilityScore: "80",
        }),
        { minimumSkillMatches: 3, minimumFeasibilityScore: 80 },
    );
    assert.deepEqual(
        normalizeFeasibilitySettings({
            minimumSkillMatches: 0,
            minimumFeasibilityScore: 75,
        }),
        { minimumSkillMatches: 1, minimumFeasibilityScore: 60 },
    );
    assert.equal(
        normalizeFeasibilitySettings({ minimumFeasibilityScore: 80 }).minimumFeasibilityScore,
        80,
    );
});

test("resolves currency codes from nested and flattened Freelancer fields", () => {
    assert.equal(getBudgetCurrencyCode({
        BudgetCurrency: "currency.code",
        currency: { code: "USD" },
    }), "USD");
    assert.equal(getBudgetCurrencyCode({ "currency.code": "EUR" }), "EUR");
    assert.equal(getBudgetCurrencyCode({ BudgetCurrency: "gbp" }), "GBP");
    assert.equal(getBudgetCurrencyCode({ BudgetCurrency: "currency.code" }), "");
});

test("keeps projects with missing or unsupported currencies from aborting selection", () => {
    const project = {
        id: "123",
        BudgetCurrency: "currency.code",
        MinBudget: 10,
        MaxBudget: 20,
    };

    Force_ProjectAnalyser(project);
    projectPlanner_PlanBid(project);

    assert.equal(project.BudgetCurrency, "");
    assert.equal(project.BudgetCurrencySupported, false);
    assert.equal(project.PlanBid, "Bad_Currency");
    assert.equal(project.MinBudget_USD, "");
});

test("formats server timestamps in Japan time and parses sheet timestamps as JST", () => {
    const instant = new Date("2026-11-11T03:04:05.000Z");
    assert.equal(formatJstDateTime(instant), "2026-11-11 12:04:05");
    assert.equal(
        parseJstTimestamp("2026-11-11 12:04:05"),
        Date.parse("2026-11-11T12:04:05+09:00"),
    );
    assert.equal(
        parseJstTimestamp("2026-11-11T12:04:05Z"),
        Date.parse("2026-11-11T12:04:05Z"),
    );
});

test("accepts only project registrations from the trailing 24 hours", () => {
    const now = Date.parse("2026-11-11T03:00:00Z");
    assert.equal(isProjectRegisteredWithinLast24Hours("2026-11-10 12:00:00", now), true);
    assert.equal(isProjectRegisteredWithinLast24Hours("2026-11-10 11:59:59", now), false);
    assert.equal(isProjectRegisteredWithinLast24Hours("2026-11-11 12:00:01", now), false);
    assert.equal(isProjectRegisteredWithinLast24Hours("not a timestamp", now), false);
});

test("accepts feasibility scores from 0 to 100 in increments of 10", () => {
    assert.deepEqual(
        parseFeasibilityAssessment('```json\n{"score": 70, "reasoning": "Strong skill match"}\n```'),
        { score: 70, reasoning: "Strong skill match" },
    );
    assert.throws(() => parseFeasibilityAssessment('{"score": 75}'), /invalid score/i);
    assert.throws(() => parseFeasibilityAssessment('{"score": null}'), /invalid score/i);
    assert.throws(() => parseFeasibilityAssessment('{"score": "80"}'), /invalid score/i);
    assert.throws(() => parseFeasibilityAssessment("not JSON"), /no JSON object/i);
});

test("provides a comprehensive country picker list with common country names", () => {
    assert.ok(AVAILABLE_COUNTRIES.length >= 240);
    assert.ok(AVAILABLE_COUNTRIES.includes("Japan"));
    assert.ok(AVAILABLE_COUNTRIES.includes("South Africa"));
    assert.ok(AVAILABLE_COUNTRIES.includes("United States"));
    assert.equal(new Set(AVAILABLE_COUNTRIES).size, AVAILABLE_COUNTRIES.length);
});
