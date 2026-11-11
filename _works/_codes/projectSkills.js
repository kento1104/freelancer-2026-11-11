export function parseProjectJobs(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || value.trim() === "") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return value.split(",").map(name => name.trim()).filter(Boolean);
    }
}

function normalizeSkillName(skill) {
    return String(skill ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getProjectSkillNames(jobs) {
    return jobs.map(job => {
        if (typeof job === "string") return job;
        if (job && typeof job === "object" && !Array.isArray(job)) {
            return String(job.name ?? job.skill ?? "").trim();
        }
        return "";
    }).filter(Boolean);
}

export function getMatchedSkills(jobs, profileSkills) {
    const userSkills = new Set(
        profileSkills.split(",").map(normalizeSkillName).filter(Boolean)
    );
    const matchedSkills = new Map();
    for (const skill of getProjectSkillNames(jobs)) {
        const normalized = normalizeSkillName(skill);
        if (normalized && userSkills.has(normalized)) matchedSkills.set(normalized, skill.trim());
    }
    return [...matchedSkills.values()];
}

export function normalizeFeasibilitySettings(settings = {}) {
    const requestedMatches = Number(settings.minimumSkillMatches);
    const requestedScore = Number(settings.minimumFeasibilityScore);
    return {
        minimumSkillMatches: Number.isSafeInteger(requestedMatches) && requestedMatches >= 1
            ? Math.min(requestedMatches, 100)
            : 1,
        minimumFeasibilityScore: Number.isInteger(requestedScore)
            && requestedScore >= 0
            && requestedScore <= 100
            && requestedScore % 10 === 0
            ? requestedScore
            : 60,
    };
}
