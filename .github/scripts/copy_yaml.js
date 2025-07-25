const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const { GoogleGenAI } = require("@google/genai");

const sourceYamlPath = process.env.SOURCE_YAML_PATH; // src/global.yaml (English)

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error("Error: GEMINI_API_KEY environment variable is not set.");
  process.exit(1);
}

const ai = new GoogleGenAI({});

if (!sourceYamlPath) {
  console.error("Error: SOURCE_YAML_PATH environment variable must be set.");
  process.exit(1);
}

const LOCALE_CONFIGS = [
  { folder: "es-es", langCode: "es", name: "Spanish (Spain)" },
  { folder: "fr-fr", langCode: "fr", name: "French (France)" },
  { folder: "jp-jp", langCode: "ja", name: "Japanese (Japan)" },
  { folder: "ko-kr", langCode: "ko", name: "Korean (Korea)" },
  { folder: "ar-sa", langCode: "ar", name: "Arabic (Saudi Arabia)" },
  { folder: "ru-ru", langCode: "ru", name: "Russian (Russia)" },
  // { folder: 'pl-pl', langCode: 'pl', name: 'Polish (Poland)' },
];

function getFileContentFromCommit(filePath, commitRef) {
  try {
    return execSync(`git show ${commitRef}:${filePath}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).toString();
  } catch (error) {
    return "";
  }
}

/**
 * Recursively finds changed string values between two YAML objects (additions/modifications).
 * Returns an object with dot-separated keys and their new string values.
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
      } else if (
        typeof currentVal === "object" &&
        currentVal !== null &&
        !Array.isArray(currentVal)
      ) {
        getChangedStrings(currentVal, previousVal, changes, fullKey);
      }
    }
  }
  return changes;
}

/**
 * Recursively extracts all string values from a YAML object.
 * Returns an object with dot-separated keys and their string values.
 */
function getAllStringsFromObject(obj, allStrings = {}, prefix = "") {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const val = obj[key];
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (typeof val === "string") {
        allStrings[fullKey] = val;
      } else if (
        typeof val === "object" &&
        val !== null &&
        !Array.isArray(val)
      ) {
        getAllStringsFromObject(val, allStrings, fullKey);
      }
    }
  }
  return allStrings;
}

/**
 * Recursively removes keys from targetObj if they are missing in sourceObj.
 * @param {object} targetObj - The object to modify (e.g., existing French translations).
 * @param {object} sourceObj - The reference object (e.g., current English strings).
 * @returns {boolean} True if any keys were deleted, false otherwise.
 */
function removeDeletedKeys(targetObj, sourceObj) {
  let hasDeleted = false;
  for (const key in targetObj) {
    if (Object.prototype.hasOwnProperty.call(targetObj, key)) {
      if (!Object.prototype.hasOwnProperty.call(sourceObj, key)) {
        // Key exists in target but not in source: delete it
        console.log(`Deleting key '${key}' from target translations.`);
        delete targetObj[key];
        hasDeleted = true;
      } else if (
        typeof targetObj[key] === "object" &&
        targetObj[key] !== null &&
        !Array.isArray(targetObj[key]) &&
        typeof sourceObj[key] === "object" &&
        sourceObj[key] !== null &&
        !Array.isArray(sourceObj[key])
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

async function translateString(text, targetLanguage) {
  if (text.trim() === "") {
    return text;
  }
  try {
    console.log(`Translating (GenAI) to ${targetLanguage}: "${text}"`);

    const prompt = `Translate the following English text to ${targetLanguage}. Do not translate the texts within the {}. Only return the translated text:\n\n"${text}"`;
    const result = await ai.models.generateContent({
      contents: prompt,
      model: "gemini-2.5-flash-lite",
    });

    const translatedText = result.text;

    console.log(`Translated "${text}" to "${translatedText}"`);

    return translatedText.trim();
  } catch (error) {
    console.error(
      `ERROR during GenAI translation for text "${text}" to ${targetLanguage}:`,
    );
    console.error(error);

    if (error.response) {
      console.error(
        "API Response Error:",
        error.response.status,
        error.response.statusText,
      );

      if (error.response.data) {
        console.error("API Response Data:", error.response.data);
      }
    } else if (error.message) {
      console.error("Error message:", error.message);
    }

    return `[Translation Error with GenAI to ${targetLanguage}] ${text}`;
  }
}

function setDeep(obj, path, value) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !current[part] ||
      typeof current[part] !== "object" ||
      Array.isArray(current[part])
    ) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

async function main() {
  try {
    // 1. Get current and previous versions of src/global.yaml (Source is common for all locales)
    console.log(`Reading current source file: ${sourceYamlPath}`);
    const currentSourceContent = fs.readFileSync(sourceYamlPath, "utf8");
    const currentEnglishStrings = yaml.load(currentSourceContent);

    const previousCommitSha = process.env.GITHUB_SHA_BEFORE;
    console.log(
      `Fetching previous source file content from commit: ${previousCommitSha || "initial commit (no previous SHA)"}`,
    );
    const previousSourceContent = getFileContentFromCommit(
      sourceYamlPath,
      previousCommitSha,
    );
    const previousEnglishStrings = previousSourceContent
      ? yaml.load(previousSourceContent)
      : {};

    let overallHasActualChanges = false; // Flag to track if ANY locale file was actually updated

    // --- Loop through each locale ---
    for (const localeConfig of LOCALE_CONFIGS) {
      const localeFolder = localeConfig.folder;
      const targetLangName = localeConfig.name;

      const currentTargetYamlPath = `generated/${localeFolder}/global.yaml`;
      const currentTargetDirectory = path.dirname(currentTargetYamlPath);

      console.log(
        `\n--- Processing locale: ${targetLangName} (${localeFolder}) ---`,
      );

      let existingLocaleStrings = {};
      const isNewLocaleFile = !fs.existsSync(currentTargetYamlPath); // Check existence here
      if (isNewLocaleFile) {
        console.log(
          `Target file ${currentTargetYamlPath} does not exist. It will be created and fully populated.`,
        );
      } else {
        console.log(`Loading existing target file: ${currentTargetYamlPath}`);
        const existingTargetContent = fs.readFileSync(
          currentTargetYamlPath,
          "utf8",
        );
        existingLocaleStrings = yaml.load(existingTargetContent);
      }

      const finalLocaleStrings = JSON.parse(
        JSON.stringify(existingLocaleStrings),
      );
      let hasChangesForThisLocale = false; // Flag for this specific locale's changes

      // --- Handle Deleted Keys ---
      // Only remove deleted keys if it's NOT a new locale file (no need to delete from an empty new file)
      console.log(`[${localeFolder}] Checking for deleted keys...`);
      if (
        !isNewLocaleFile &&
        removeDeletedKeys(finalLocaleStrings, currentEnglishStrings)
      ) {
        hasChangesForThisLocale = true;
      }

      // --- Determine strings to translate for THIS locale ---
      let stringsToTranslateForThisLocale = {};
      if (isNewLocaleFile) {
        // If it's a new file, translate ALL strings from the current English source
        console.log(
          `[${localeFolder}] New locale file detected. Translating all strings from source.`,
        );
        stringsToTranslateForThisLocale = getAllStringsFromObject(
          currentEnglishStrings,
        );
      } else {
        // Otherwise, only translate strings that changed in the source (current vs previous source)
        console.log(
          `[${localeFolder}] Existing locale file. Identifying added/modified strings from source changes.`,
        );
        stringsToTranslateForThisLocale = getChangedStrings(
          currentEnglishStrings,
          previousEnglishStrings,
        );
      }

      const changedKeys = Object.keys(stringsToTranslateForThisLocale);

      if (changedKeys.length === 0 && !hasChangesForThisLocale) {
        console.log(
          `[${localeFolder}] No new, modified, or deleted strings found. Skipping translation for this locale.`,
        );
        continue; // Move to the next locale
      }

      if (changedKeys.length > 0) {
        console.log(
          `[${localeFolder}] Found ${changedKeys.length} strings to translate/update.`,
        );
        console.log(
          `[${localeFolder}] Keys to translate:`,
          changedKeys.join(", "),
        );

        for (const key of changedKeys) {
          const englishText = stringsToTranslateForThisLocale[key];
          const translatedText = await translateString(
            englishText,
            targetLangName,
          );

          let currentTranslatedValue;
          try {
            currentTranslatedValue = key
              .split(".")
              .reduce((o, i) => o && o[i], finalLocaleStrings);
          } catch (e) {
            currentTranslatedValue = undefined;
          }

          if (translatedText !== currentTranslatedValue) {
            setDeep(finalLocaleStrings, key, translatedText);
            hasChangesForThisLocale = true;
            console.log(
              `[${localeFolder}] Updated translation for key "${key}"`,
            );
          } else {
            console.log(
              `[${localeFolder}] No change in translated text for key "${key}", skipping update.`,
            );
          }
        }
      }

      if (!hasChangesForThisLocale) {
        console.log(
          `[${localeFolder}] No actual content changes (additions, modifications, or deletions) detected. No file write needed for this locale.`,
        );
        continue; // Move to the next locale
      }

      // 5. Dump the final content back into YAML format for this locale
      console.log(
        `[${localeFolder}] Dumping final ${targetLangName} content to YAML...`,
      );

      const dumpedYaml = yaml.dump(finalLocaleStrings, {
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: true,
      });

      // 6. Ensure the target directory exists for this locale
      if (!fs.existsSync(currentTargetDirectory)) {
        console.log(
          `[${localeFolder}] Creating target directory: ${currentTargetDirectory}`,
        );
        fs.mkdirSync(currentTargetDirectory, { recursive: true });
      }

      // 7. Write the content to the target YAML file for this locale
      console.log(
        `[${localeFolder}] Writing updated translated content to target file: ${currentTargetYamlPath}`,
      );
      fs.writeFileSync(currentTargetYamlPath, dumpedYaml, "utf8");

      console.log(
        `[${localeFolder}] Successfully updated changed strings in '${currentTargetYamlPath}'`,
      );
      overallHasActualChanges = true; // Mark that at least one file was updated
    } // End of locale loop

    if (!overallHasActualChanges) {
      console.log(
        "No changes detected in any locale file across all configured locales. Exiting successfully without creating a PR.",
      );
      process.exit(0);
    }

    console.log(
      "Translation process completed for all locales. Changes detected, proceeding to PR creation.",
    );
  } catch (error) {
    console.error(`Fatal error in translation process: ${error.message}`);
    process.exit(1);
  }
}

main();
