
const GOOD_CURRENCIES = ["USD", "GBP", "EUR"];
const VERIFICATION_FIELDS = {
    Identity_verified: ["Identity_verified", "identity_verified"],
    Payment_verified: ["Payment_verified", "payment_verified"],
    Deposit_made: ["Deposit_made", "deposit_made"],
    Email_verified: ["Email_verified", "email_verified"],
    Profile_completed: ["Profile_completed", "profile_completed", "profile_complete"],
    Phone_verified: ["Phone_verified", "phone_verified"],
};

export const DEFAULT_PLAN_BID_SETTINGS = {
    badCountries: [
        "Bangladesh", "Pakistan", "India", "Nepal", "Sri Lanka", "Philippines",
        "Vietnam", "Indonesia", "Malaysia", "Thailand", "Nigeria", "Kenya",
        "South Africa", "Ukraine", "China", "Taiwan", "Hong Kong", "Macau",
        "Korea", "Cambodia", "Laos", "Myanmar",
    ],
    badVerifications: ["Deposit_made", "Payment_verified"],
    Bad_over50pHr: 50,
    Bad_over2500: 2500,
};

const VALID_VERIFICATIONS = new Set(Object.keys(VERIFICATION_FIELDS));

export function normalizePlanBidSettings(settings = {}) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        settings = {};
    }

    const badCountries = Array.isArray(settings.badCountries)
        ? [...new Set(settings.badCountries
            .filter(country => typeof country === "string")
            .map(country => country.trim())
            .filter(Boolean))]
        : [...DEFAULT_PLAN_BID_SETTINGS.badCountries];
    const badVerifications = Array.isArray(settings.badVerifications)
        ? [...new Set(settings.badVerifications.filter(field => VALID_VERIFICATIONS.has(field)))]
        : [...DEFAULT_PLAN_BID_SETTINGS.badVerifications];

    return {
        badCountries,
        badVerifications,
        Bad_over50pHr: settings.Bad_over50pHr !== null
            && settings.Bad_over50pHr !== ""
            && Number.isFinite(Number(settings.Bad_over50pHr))
            && Number(settings.Bad_over50pHr) >= 0
            ? Number(settings.Bad_over50pHr)
            : DEFAULT_PLAN_BID_SETTINGS.Bad_over50pHr,
        Bad_over2500: settings.Bad_over2500 !== null
            && settings.Bad_over2500 !== ""
            && Number.isFinite(Number(settings.Bad_over2500))
            && Number(settings.Bad_over2500) >= 0
            ? Number(settings.Bad_over2500)
            : DEFAULT_PLAN_BID_SETTINGS.Bad_over2500,
    };
}

function isEnabled(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1;

    const normalized = String(value ?? "").trim().toLowerCase();
    return ["true", "yes", "1"].includes(normalized);
}

function getVerificationFlag(projectInfo, fields) {
    return fields.some(field =>
        isEnabled(projectInfo[field])
        || isEnabled(projectInfo.owner_info?.status?.[field])
    );
}

function get_PlanBid(projectInfo, settings) {
    if(projectInfo['Prefered']) return "Bad_Prefered";
    if (projectInfo.BudgetCurrencySupported === false) return "Bad_Currency";

    if (settings.badVerifications.some(field =>
        !getVerificationFlag(projectInfo, VERIFICATION_FIELDS[field])
    )) {
        return "Bad_Verify";
    }

    const country = String(projectInfo['Country'] ?? "").toLowerCase();
    if (settings.badCountries.some(badCountry => country.includes(badCountry.toLowerCase()))) {
        return "Bad_Country";
    }

    if (GOOD_CURRENCIES.some(currency => String(projectInfo['BudgetCurrency'] ?? "").includes(currency))) {
        if(projectInfo['ProjectType'] == "Hourly") {
            if (Number(projectInfo['MinBudget']) >= settings.Bad_over50pHr) {
                return "Bad_over50pHr";
            }
        }
        else if(projectInfo['ProjectType'] == "Fixed") {
            if (Number(projectInfo['MinBudget']) >= settings.Bad_over2500) {
                return "Bad_over2500";
            }
        }
    }

    return "Good";
}



export default (projectInfo, planBidSettings) => {
    const settings = normalizePlanBidSettings(planBidSettings);
    const planBid = get_PlanBid(projectInfo, settings);
    const normalizedPlanBid = planBid === "Good" ? "good" : planBid;

    projectInfo['PlanBid'] = planBid;
    projectInfo['plan_bid'] = normalizedPlanBid;
    return projectInfo;
}
