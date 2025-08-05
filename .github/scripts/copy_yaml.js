const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const { GoogleGenAI } = require("@google/genai");

// --- CONFIGURATION ---

// Path to the source English YAML file.
const sourceYamlPath = process.env.SOURCE_YAML_PATH; // e.g., 'src/global.yaml'

// Your Gemini API Key from environment variables.
const geminiApiKey = process.env.GEMINI_API_KEY;

// The file where we store the SHA of the last commit we successfully translated.
// **This file should be committed to your repository.**
const STATE_FILE_PATH = "translation_state.json";

// The list of locales to translate to.
const LOCALE_CONFIGS = [
  { folder: "es-es", langCode: "es", name: "Spanish (Spain)" },
  { folder: "fr-fr", langCode: "fr", name: "French (France)" },
  { folder: "jp-jp", langCode: "ja", name: "Japanese (Japan)" },
  { folder: "ko-kr", langCode: "ko", name: "Korean (Korea)" },
  { folder: "ar-sa", langCode: "ar", name: "Arabic (Saudi Arabia)" },
  { folder: "ru-ru", langCode: "ru", name: "Russian (Russia)" },
  { folder: 'pl-pl', langCode: 'pl', name: 'Polish (Poland)' },
];

// --- SCRIPT START ---

if (!sourceYamlPath) {
  console.error("Error: SOURCE_YAML_PATH environment variable must be set.");
  process.exit(1);
}
if (!geminiApiKey) {
  console.error("Error: GEMINI_API_KEY environment variable is not set.");
  process.exit(1);
}

const ai = new GoogleGenAI({apiKey: geminiApiKey});

/**
 * Gets the content of a file from a specific git commit.
 * Returns an empty string if the file doesn't exist at that commit.
 */
function getFileContentFromCommit(filePath, commitRef) {
  if (!commitRef) {
    return "";
  }
  try {
    console.log(`Inspecting file '${filePath}' at commit '${commitRef}'`);
    // Use stdio: 'pipe' to prevent git errors from polluting the console.
    return execSync(`git show ${commitRef}:${filePath}`, {
      encoding: "utf8",
      stdio: "pipe",
    }).toString();
  } catch (error) {
    // This is an expected case if the file was created in the current commit.
    console.warn(`Warning: Could not find file '${filePath}' at commit '${commitRef}'. Assuming it's a new file.`);
    return "";
  }
}

/**
 * Recursively finds changed string values (additions/modifications) between two objects.
 */
function getChangedStrings(currentObj, previousObj, changes = {}, prefix = "") {
  for (const key in currentObj) {
    if (Object.prototype.hasOwnProperty.call(currentObj, key)) {
      const currentVal = currentObj[key];
      const previousVal = previousObj ? previousObj[key] : undefined;
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (typeof currentVal === "string") {
        if (currentVal !== previousVal) {
          changes[fullKey] = currentVal;
        }
      } else if (typeof currentVal === "object" && currentVal !== null && !Array.isArray(currentVal)) {
        // Recurse into nested objects
        const nestedPreviousObj = (typeof previousVal === 'object' && previousVal !== null) ? previousVal : {};
        getChangedStrings(currentVal, nestedPreviousObj, changes, fullKey);
      }
    }
  }
  return changes;
}

/**
 * Recursively extracts all string values from an object. Used for new locale files.
 */
function getAllStringsFromObject(obj, allStrings = {}, prefix = "") {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const val = obj[key];
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof val === 'string') {
        allStrings[fullKey] = val;
      } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        getAllStringsFromObject(val, allStrings, fullKey);
      }
    }
  }
  return allStrings;
}

/**
 * Recursively removes keys from a target object if they are missing in a source object.
 * This keeps the translation files in sync with the source English file.
 */
function removeDeletedKeys(targetObj, sourceObj) {
  let hasDeleted = false;
  for (const key in targetObj) {
    if (Object.prototype.hasOwnProperty.call(targetObj, key)) {
      if (!Object.prototype.hasOwnProperty.call(sourceObj, key)) {
        console.log(`- Deleting obsolete key '${key}' from target translations.`);
        delete targetObj[key];
        hasDeleted = true;
      } else if (
        typeof targetObj[key] === "object" && targetObj[key] !== null && !Array.isArray(targetObj[key]) &&
        typeof sourceObj[key] === "object" && sourceObj[key] !== null && !Array.isArray(sourceObj[key])
      ) {
        // Recurse for nested objects
        if (removeDeletedKeys(targetObj[key], sourceObj[key])) {
          hasDeleted = true;
        }
      }
    }
  }
  return hasDeleted;
}

/**
 * Translates a single string using the Gemini API.
 */
async function translateString(text, targetLanguage) {
  if (!text || text.trim() === "") {
    return text;
  }
  try {
    console.log(`   Translating to ${targetLanguage}: "${text}"`);
    const prompt = `Translate the following English text to ${targetLanguage}. Do not translate placeholders inside curly braces like {name} or {count}. Only return the translated text, without any introductory phrases or quotation marks.\n\nEnglish text: "${text}"`;

    const result = await ai.models.generateContent({
      contents: prompt,
      model: "gemini-2.5-flash-lite",
    });

    return result.text;
  } catch (error) {
    console.error(`ERROR during GenAI translation for text "${text}" to ${targetLanguage}:`, error);
    return `[Translation Error] ${text}`;
  }
}

/**
 * Sets a value in a nested object using a dot-separated path.
 */
function setDeep(obj, path, value) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Main function to run the translation process.
 */
async function main() {
  const currentCommitSha = process.env.GITHUB_SHA;
  if (!currentCommitSha) {
    console.error("Error: GITHUB_SHA environment variable is not set. This script is intended to be run in a GitHub Action.");
    process.exit(1);
  }

  // 1. Read the state file to find out which commit was last translated.
  let previousCommitSha = null;
  let isFirstRun = true;
  if (fs.existsSync(STATE_FILE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, "utf8"));
      if (state.lastTranslatedCommit) {
        previousCommitSha = state.lastTranslatedCommit;
        isFirstRun = false;
        console.log(`Found last translated commit: ${previousCommitSha}`);
      } else {
        console.log(`State file found, but 'lastTranslatedCommit' is null. This will be treated as the first run.`);
      }
    } catch (e) {
      console.error(`Error reading or parsing ${STATE_FILE_PATH}. Treating as first run.`, e);
    }
  } else {
    console.log(`'${STATE_FILE_PATH}' not found. This must be the first run. All strings will be translated.`);
  }

  // 2. Get current and previous versions of the source YAML file.
  const currentSourceContent = fs.readFileSync(sourceYamlPath, "utf8");
  const currentEnglishStrings = yaml.load(currentSourceContent) || {};

  const previousSourceContent = getFileContentFromCommit(sourceYamlPath, previousCommitSha);
  const previousEnglishStrings = previousSourceContent ? (yaml.load(previousSourceContent) || {}) : {};

  // 3. Identify strings that have been added or modified since the last run.
  const stringsToTranslate = getChangedStrings(currentEnglishStrings, previousEnglishStrings);
  const keysToTranslate = Object.keys(stringsToTranslate);

  let anyFileWasModified = false;

  // 4. Loop through each locale to apply changes.
  for (const locale of LOCALE_CONFIGS) {
    const targetYamlPath = `generated/${locale.folder}/global.yaml`;
    const targetDirectory = path.dirname(targetYamlPath);
    console.log(`\n--- Processing locale: ${locale.name} (${locale.folder}) ---`);

    let finalLocaleStrings = {};
    let hasChangesForThisLocale = false;
    const localeFileExists = fs.existsSync(targetYamlPath);

    if (!localeFileExists) {
        console.log(`Target file ${targetYamlPath} does not exist. It will be fully translated from the current source.`);
        const allSourceStrings = getAllStringsFromObject(currentEnglishStrings);
        for (const key of Object.keys(allSourceStrings)) {
            const translatedText = await translateString(allSourceStrings[key], locale.name);
            setDeep(finalLocaleStrings, key, translatedText);
        }
        hasChangesForThisLocale = Object.keys(allSourceStrings).length > 0;
    } else {
        const existingTargetContent = fs.readFileSync(targetYamlPath, "utf8");
        finalLocaleStrings = yaml.load(existingTargetContent) || {};

        // A. Synchronize deletions: remove keys that no longer exist in the English source.
        if (removeDeletedKeys(finalLocaleStrings, currentEnglishStrings)) {
            hasChangesForThisLocale = true;
        }

        // B. Translate new and updated keys.
        if (keysToTranslate.length > 0) {
            console.log(`Translating ${keysToTranslate.length} new/modified strings...`);
            for (const key of keysToTranslate) {
                const englishText = stringsToTranslate[key];
                const translatedText = await translateString(englishText, locale.name);
                setDeep(finalLocaleStrings, key, translatedText);
            }
            hasChangesForThisLocale = true;
        }
    }

    if (!hasChangesForThisLocale) {
        console.log(`No changes needed for ${locale.name}. Skipping file write.`);
        continue;
    }

    // 5. Write the updated translations to the YAML file if changes were made.
    anyFileWasModified = true;
    console.log(`Writing updated file for ${locale.name} to ${targetYamlPath}`);
    const newYamlContent = yaml.dump(finalLocaleStrings, { lineWidth: -1, quotingType: '"', forceQuotes: true });
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(targetYamlPath, newYamlContent, "utf8");
    console.log(`✔ Successfully updated translations for ${locale.name}.`);
  }

  // 6. If anything changed, update the state file with the current commit SHA for the next run.
  // We also update on the first run to establish the initial state.
  if (anyFileWasModified || isFirstRun) {
      console.log(`\nUpdating state file to new commit: ${currentCommitSha}`);
      const newState = { lastTranslatedCommit: currentCommitSha };
      fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(newState, null, 2), "utf8");
      console.log(`'${STATE_FILE_PATH}' has been updated. Please ensure this file is committed.`);
  } else {
      console.log("\nNo changes detected in any locale file. State file remains unchanged.");
  }
}

main().catch(err => {
    console.error("\nA fatal error occurred during the script execution:", err);
    process.exit(1);
});
