const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const { GoogleGenAI } = require("@google/genai");

const sourceYamlPath = process.env.SOURCE_YAML_PATH; // e.g., 'src/global.yaml'
const geminiApiKey = process.env.GEMINI_API_KEY;
const previousCommitSha = process.env.GITHUB_SHA_BEFORE;

if (!sourceYamlPath || !geminiApiKey || !previousCommitSha) {
  console.error(
    "Error: SOURCE_YAML_PATH, GEMINI_API_KEY, and GITHUB_SHA_BEFORE environment variables must be set."
  );
  process.exit(1);
}

const ai = new GoogleGenAI({});

const LOCALE_CONFIGS = [
    { folder: "es-es", langCode: "es", name: "Spanish (Spain)" },
    { folder: "fr-fr", langCode: "fr", name: "French (France)" },
    { folder: "jp-jp", langCode: "ja", name: "Japanese (Japan)" },
    { folder: "ko-kr", langCode: "ko", name: "Korean (Korea)" },
    { folder: "ar-sa", langCode: "ar", name: "Arabic (Saudi Arabia)" },
    { folder: "ru-ru", langCode: "ru", name: "Russian (Russia)" },
    { folder: 'pl-pl', langCode: 'pl', name: 'Polish (Poland)' },
];

function getFileContentFromCommit(filePath, commitRef) {
  if (!commitRef || commitRef === '0000000000000000000000000000000000000000') {
    // This is the first commit in a repo, no previous state exists.
    return "";
  }
  try {
    return execSync(`git show ${commitRef}:${filePath}`, {
      encoding: "utf8",
      stdio: "pipe", // Simplified stdio
    }).toString();
  } catch (error) {
    // This likely means the file did not exist in the previous commit, which is fine.
    console.log(`Note: Could not find file '${filePath}' at previous commit '${commitRef}'. Assuming it's a new file.`);
    return "";
  }
}

/**
 * Flattens a nested object into a single-level object with dot-separated keys.
 * e.g., { a: { b: 'c' } } becomes { 'a.b': 'c' }
 */
function flattenObject(obj, prefix = "", result = {}) {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
        flattenObject(obj[key], newKey, result);
      } else {
        result[newKey] = obj[key];
      }
    }
  }
  return result;
}

/**
 * Unflattens an object with dot-separated keys back into a nested object.
 */
function unflattenObject(obj) {
  const result = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const keys = key.split('.');
      keys.reduce((acc, currentKey, index) => {
        if (index === keys.length - 1) {
          acc[currentKey] = obj[key];
        } else {
          acc[currentKey] = acc[currentKey] || {};
        }
        return acc[currentKey];
      }, result);
    }
  }
  return result;
}

async function translateString(text, targetLanguageName) {
  if (typeof text !== 'string' || text.trim() === "") {
    return text; // Return non-strings or empty strings as-is
  }
  try {
    console.log(`   Translating to ${targetLanguageName}: "${text}"`);
    const prompt = `Translate the following English text to ${targetLanguageName}. Only return the translated text. Do not add quotes around the translation. Do not translate placeholders like {placeholder}. Text: "${text}"`;

    const result = await ai.model.generateContent({
      contents: prompt,
      model: "gemini-2.5-flash-lite",
    });
    const response = await result.text;
    const translatedText = response.text().trim();

    console.log(`   -> Translated to: "${translatedText}"`);
    return translatedText;
  } catch (error) {
    console.error(`ERROR during GenAI translation for text "${text}" to ${targetLanguageName}:`, error);
    return `[Translation Error] ${text}`;
  }
}

async function main() {
  console.log("Starting incremental translation process...");

  // 1. Load current and previous versions of the source English file
  const currentSourceContent = fs.readFileSync(sourceYamlPath, "utf8");
  const previousSourceContent = getFileContentFromCommit(sourceYamlPath, previousCommitSha);

  const currentSourceObj = yaml.load(currentSourceContent);
  const previousSourceObj = previousSourceContent ? yaml.load(previousSourceContent) : {};

  // 2. Flatten the source objects for easier key-value comparison
  const flatCurrentSource = flattenObject(currentSourceObj);
  const flatPreviousSource = flattenObject(previousSourceObj);

  let overallHasActualChanges = false;

  // 3. Process each target locale
  for (const localeConfig of LOCALE_CONFIGS) {
    const { folder, name: targetLanguageName } = localeConfig;
    const targetYamlPath = `generated/${folder}/global.yaml`;
    console.log(`\n--- Processing Locale: ${targetLanguageName} (${folder}) ---`);

    // 4. Load the existing/stale translated file from the current checkout
    // This file corresponds to the "previous" source state. We use it to reuse translations.
    let existingLocaleObj = {};
    try {
      if (fs.existsSync(targetYamlPath)) {
        const existingLocaleContent = fs.readFileSync(targetYamlPath, 'utf8');
        existingLocaleObj = yaml.load(existingLocaleContent);
      }
    } catch (e) {
      console.warn(`Could not read or parse existing locale file at ${targetYamlPath}. Will treat as new.`);
    }
    const flatExistingLocale = flattenObject(existingLocaleObj);

    const newFlatLocale = {};
    let hasChangesForThisLocale = false;

    // 5. Core Logic: Iterate through all keys in the CURRENT source file
    for (const key in flatCurrentSource) {
      const currentEnglishText = flatCurrentSource[key];
      const previousEnglishText = flatPreviousSource[key];
      const existingTranslation = flatExistingLocale[key];

      // If the English text hasn't changed and a translation already exists, reuse it.
      if (currentEnglishText === previousEnglishText && existingTranslation !== undefined) {
        newFlatLocale[key] = existingTranslation;
      } else {
        // Otherwise, it's a new key or the source text has changed, so we must translate.
        console.log(`[${folder}] Change detected for key: "${key}"`);
        hasChangesForThisLocale = true;
        const newTranslation = await translateString(currentEnglishText, targetLanguageName);
        newFlatLocale[key] = newTranslation;
      }
    }

    // Check if any keys were deleted by comparing key sets
    const currentKeys = Object.keys(flatCurrentSource);
    const existingKeys = Object.keys(flatExistingLocale);
    if (currentKeys.length !== existingKeys.length) {
      // This is a simplistic but effective check for deletions.
      hasChangesForThisLocale = true;
    }

    if (!hasChangesForThisLocale) {
        console.log(`[${folder}] No changes detected. Skipping file write.`);
        continue;
    }

    // 6. Reconstruct the nested object from the new flat map
    const finalNewLocaleObj = unflattenObject(newFlatLocale);

    const newYamlContent = yaml.dump(finalNewLocaleObj, {
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: true,
    });

    // Ensure the target directory exists
    const targetDirectory = path.dirname(targetYamlPath);
    if (!fs.existsSync(targetDirectory)) {
        fs.mkdirSync(targetDirectory, { recursive: true });
    }

    fs.writeFileSync(targetYamlPath, newYamlContent, "utf8");
    console.log(`[${folder}] Successfully updated and wrote changes to '${targetYamlPath}'`);
    overallHasActualChanges = true;
  }

  if (!overallHasActualChanges) {
    console.log("\nNo translatable changes detected across any locale. Exiting.");
    // We can exit gracefully. The create-pull-request step will do nothing if there are no file changes.
  } else {
    console.log("\nTranslation process complete. Proceeding to PR creation step.");
  }
}

main().catch((error) => {
  console.error("A fatal error occurred:", error);
  process.exit(1);
});
