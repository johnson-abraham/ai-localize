# ai-localize

**ai-localize** is an automated localization tool that leverages OpenAI and GitHub Actions to translate your application's strings seamlessly. It monitors your source YAML file and automatically employs AI to translate new or modified content into multiple languages, creating a Pull Request with the updates.

## 🚀 How It Works

This repository is configured with a GitHub Action workflow that automates the translation process:

1.  **Monitor**: The workflow triggers whenever changes are pushed to `src/global.yaml` on the master branch.
2.  **Analyze**: The script (`.github/scripts/copy_yaml.js`) compares the current version of the file with the last successfully translated version (tracked in `translation_state.json`).
3.  **Translate**: It identifies added or modified strings and uses OpenAI's API (specifically `gpt-5-nano`) to translate them into configured target locales.
4.  **Generate**: Translation files are generated or updated in the `generated/` directory.
5.  **Pull Request**: A new Pull Request is automatically created containing the updated translations and the new state.

## 🛠️ Setup

To use this workflow, you need to configure the following secrets in your GitHub [repository settings](https://github.com/johnson-abraham/ai-localize/settings/secrets/actions):

- `OPENAI_API_KEY`: Your OpenAI API key.
- `PAT_FOR_PR`: A Personal Access Token (Classic) used to create Pull Requests.
  - **Generate at**: https://github.com/settings/profile -> Developer Settings -> Personal Access Tokens -> Tokens (Classic).
  - **Required Scopes**:
    - `repo`
    - `workflow`
    - `write:packages`
    - `delete:packages`
    - `admin:org`
    - `admin:public_key`
    - `admin:repo_hook`
    - `admin:org_hook`
    - `gist`
    - `notifications`
    - `user`

## 📂 Directory Structure

- **`src/`**: Contains the source of truth for your strings (e.g., `global.yaml`).
- **`generated/`**: Contains the machine-translated YAML files for each locale.
- **`.github/`**:
  - `workflows/copy-yaml.yml`: The GitHub Action definition.
  - `scripts/copy_yaml.js`: The Node.js script that handles the translation logic.
- **`translation_state.json`**: Tracks the commit SHA of the last successful translation to enable incremental updates.

## 🌍 Supported Languages

The project is currently configured to translate into the following locales:

- Spanish (Spain) - `es-es`
- French (France) - `fr-fr`
- Japanese (Japan) - `jp-jp`
- Korean (Korea) - `ko-kr`
- Arabic (Saudi Arabia) - `ar-sa`
- Russian (Russia) - `ru-ru`
- Polish (Poland) - `pl-pl`

## 📦 Dependencies

- [js-yaml](https://www.npmjs.com/package/js-yaml): For parsing YAML files.
- [openai](https://www.npmjs.com/package/openai): For interacting with the OpenAI API.
