import Force_BudgetSetter from './Force_BudgetSetter.js';
import AI_ProjectThinker from './AI_ProjectThinker.js';

export const PROPOSAL_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash"
];

export default async (
    projectInfo,
    guiderName,
    profileAboutMe = "",
    profileSkills = "",
    profilePrompt = "",
    apiKey
) => {
    let retries = 0;
    const unavailableModels = new Set();

    if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error("A Gemini_API_key is required for the selected user profile.");
    }

    while (retries < PROPOSAL_MODELS.length * 2) {
        const model = PROPOSAL_MODELS[retries % PROPOSAL_MODELS.length];
        if (unavailableModels.has(model)) {
            retries++;
            continue;
        }

        try {
            let tempProjectInfo = Force_BudgetSetter(projectInfo);
            tempProjectInfo = await AI_ProjectThinker(
                tempProjectInfo,
                guiderName,
                model,
                apiKey,
                profileAboutMe,
                profileSkills,
                profilePrompt
            );

            if (tempProjectInfo) {
                return tempProjectInfo;
            }
        } catch (error) {
            const retryInfo = error.errorDetails?.find(detail => detail['@type']?.endsWith('.RetryInfo'));
            const retryDelay = retryInfo?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/);
            const delayMs = retryDelay
                ? Math.ceil(Number(retryDelay[1]) * 1000)
                : Math.min(1000 * 2 ** retries, 30000);

            if (error.status === 429) {
                console.warn(`AI quota limit for model "${model}"; retrying in ${Math.ceil(delayMs / 1000)}s.`);
            } else {
                console.error(`AI request failed for model "${model}" (HTTP ${error.status || "unknown"}).`, error.message);
            }

            if (error.status === 404) {
                unavailableModels.add(model);
                retries++;
                if (unavailableModels.size === PROPOSAL_MODELS.length) break;
                continue;
            }

            if (error.status >= 400 && error.status < 500 && error.status !== 429) {
                break;
            }

            retries++;
            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue;
        }

        retries++;
    }

    throw new Error('Gemini could not generate a proposal after all retries.');
};
