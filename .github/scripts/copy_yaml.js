const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { GoogleGenAI } = require("@google/genai");

// --- CONFIGURATION ---

// Path to the source English YAML file.
const sourceYamlPath = process.env.SOURCE_YAML_PATH; // e.g., 'src/global.yaml'

// Your Gemini API Key from environment variables.
const geminiApiKey = process.env.GEMINI_API_KEY;

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
 * Recursively extracts all string values from an object.
 * @param {object} obj The object to parse.
 * @returns {object} A flat object with dot-separated keys and their string values.
 */
function getAllStrings(obj, allStrings = {}, prefix = "") {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const val = obj[key];
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (typeof val === "string") {
        allStrings[fullKey] = val;
      } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        getAllStrings(val, allStrings, fullKey);
      }
    }
  }
  return allStrings;
}

/**
 * Recursively removes keys from a target object if they are missing in a source object.
 * This keeps the translation files in sync with the source English file.
 * @param {object} targetObj The object to modify (e.g., existing French translations).
 * @param {object} sourceObj The reference object (e.g., current English strings).
 */
function removeDeletedKeys(targetObj, sourceObj) {
  for (const key in targetObj) {
    if (Object.prototype.hasOwnProperty.call(targetObj, key)) {
      if (!Object.prototype.hasOwnProperty.call(sourceObj, key)) {
        console.log(`- Deleting obsolete key '${key}' from target translations.`);
        delete targetObj[key];
      } else if (
        typeof targetObj[key] === "object" && targetObj[key] !== null && !Array.isArray(targetObj[key]) &&
        typeof sourceObj[key] === "object" && sourceObj[key] !== null && !Array.isArray(sourceObj[key])
      ) {
        // Recurse for nested objects
        removeDeletedKeys(targetObj[key], sourceObj[key]);
      }
    }
  }
}

/**
 * Translates a single string using the Gemini API.
 * @param {string} text The English text to translate.
 * @param {string} targetLanguage The full name of the target language (e.g., "Spanish (Spain)").
 * @returns {Promise<string>} The translated text.
 */
async function translateString(text, targetLanguage) {
  if (!text || text.trim() === "") {
    return text; // Return empty/whitespace strings as-is
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
 * @param {object} obj The object to modify.
 * @param {string} path The dot-separated path (e.g., "greetings.welcome").
 * @param {string} value The value to set.
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
  try {
    // 1. Load the source English strings from the YAML file.
    console.log(`Reading source file: ${sourceYamlPath}`);
    const sourceContent = fs.readFileSync(sourceYamlPath, "utf8");
    const sourceStringsObject = yaml.load(sourceContent);
    const sourceStringsFlat = getAllStrings(sourceStringsObject);

    if (Object.keys(sourceStringsFlat).length === 0) {
        console.log("Source file is empty or contains no strings. Exiting.");
        return;
    }
    console.log(`Found ${Object.keys(sourceStringsFlat).length} strings to process.`);

    // 2. Loop through each configured locale and translate.
    for (const locale of LOCALE_CONFIGS) {
      console.log(`\n--- Processing locale: ${locale.name} (${locale.folder}) ---`);
      const targetYamlPath = `generated/${locale.folder}/global.yaml`;
      const targetDirectory = path.dirname(targetYamlPath);

      let finalLocaleStrings = {}; // Start with a fresh object for the new translations.

      // 3. Translate all strings from the source file.
      for (const key of Object.keys(sourceStringsFlat)) {
        const englishText = sourceStringsFlat[key];
        const translatedText = await translateString(englishText, locale.name);
        setDeep(finalLocaleStrings, key, translatedText);
      }

      // 4. Clean up the final object by ensuring it matches the source structure.
      // (This step is implicitly handled by building `finalLocaleStrings` from `sourceStringsFlat`,
      // but we can run `removeDeletedKeys` as a safeguard if we were merging with an old file.)
      // For this simplified script, building fresh is cleaner.

      // 5. Save the translated strings to the target YAML file.
      console.log(`> Writing translations to ${targetYamlPath}`);
      const newYamlContent = yaml.dump(finalLocaleStrings, {
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: true,
      });

      fs.mkdirSync(targetDirectory, { recursive: true });
      fs.writeFileSync(targetYamlPath, newYamlContent, "utf8");

      console.log(`✔ Successfully updated translations for ${locale.name}.`);
    }

    console.log("\nTranslation process completed successfully for all locales.");

  } catch (error) {
    console.error(`\nFatal error in translation process: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
