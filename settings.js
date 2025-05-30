// @ts-check
const z = require('zod');
const fs = require('fs/promises');
const path = require('path');
const { generateObject } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { createAzure } = require('@ai-sdk/azure');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { createAmazonBedrock } = require('@ai-sdk/amazon-bedrock');
const { createDeepSeek } = require('@ai-sdk/deepseek');

const FileSystemObjectSchema = z
	.object({
		path: z.string({
			description:
				"Relative path to the file or directory that starts with './'",
		}),
		type: z.enum(['directory', 'file'], {
			description: 'Type of file system object. either file or directory',
		}),
		content: z.string({ description: 'File object contents' }).optional(),
	})
	.required({
		path: true,
		type: true,
	});

const FileSystemObjectsSchema = z.array(FileSystemObjectSchema);

const FileSystemSchema = z.object({
	fileContents: FileSystemObjectsSchema,
});

/** @typedef {z.infer<typeof FileSystemSchema>} FileSystem */

/**
 * @typedef {Object} Answers
 * @property {string} build
 * @property {string} provider
 * @property {string} model
 * @property {string} token
 * @property {string} baseUrl
 * @property {string[]} prompts
 */

/** @type {import('templates-mo/lib/types/settings').SettingsFile} */
module.exports = {
	prompts: [
		{
			name: 'build',
			description: 'Description of what you want to instruct the llm to build',
			message: 'What would you like to build?',
			tpsType: 'data',
			type: 'input',
		},
		{
			name: 'provider',
			description: 'Type of llm you want to use',
			tpsType: 'data',
			type: 'list',
			message: 'What type of llm do you want to use?',
			choices: [
				'openai',
				'anthropic',
				'azure',
				'google',
				'amazon-bedrock',
				'deepseek',
			],
			default: 'openai',
		},
		{
			name: 'model',
			description: 'Type of llm model you want to use',
			tpsType: 'data',
			type: 'input',
			message: 'What type of llm model do you want to use?',
			default: ({ provider }) => {
				return defaultModels[provider];
			},
		},
		{
			name: 'token',
			description: 'Api token for llm Api',
			tpsType: 'data',
			type: 'password',
			message: 'Enter your api token for the llm',
			when: ({ provider }) => {
				// amazon provider only supports env varibles
				if (provider === 'amazon-bedrock') return false;
				return !getEnvVar(provider);
			},
			default: ({ provider }) => {
				return getEnvVar(provider) ?? null;
			},
		},
		{
			name: 'baseUrl',
			hidden: true,
			description: 'Change the baseUrl for your AI provider',
			tpsType: 'data',
			type: 'input',
			message: 'Would you like to change the baseUrl for your AI provider?',
		},
		{
			name: 'prompts',
			hidden: true,
			// Dont prompt to user
			when: () => false,
			description: 'Additional prompts/instructions to pass to the AI model',
			tpsType: 'data',
			default: [],
		},
	],
	events: {
		/**
		 * @param {import('templates-mo')<Answers>} tps
		 */
		async onRender(tps, { buildPaths, createFile, createDirectory }) {
			const answers = tps.getAnswers();

			// amazon-bedrock requires creds via env variables
			if (!answers.token && answers.provider !== 'amazon-bedrock') {
				throw new Error('API token required!');
			}

			if (!answers.provider) {
				throw new Error('LLM provider required!');
			}

			console.log('Hold tight, AI is thinking...');

			const fileSystem = await getTemplateFromLLM(answers);

			if (!fileSystem) {
				throw new Error('LLM didnt return a valid response');
			}

			fileSystem.fileContents.forEach((file) => {
				if (file.type === 'file') {
					createFile(file.path, file.content ?? '');
				} else {
					createDirectory(file.path);
				}
			});

			console.log('Got it! Generating code...');
		},
	},
};

/**
 * @param {Answers} options
 */
const getLanguageModel = ({ baseUrl, token, provider, model }) => {
	const commonOpts = {
		baseURL: baseUrl,
		apiKey: token,
	};

	switch (provider) {
		case 'openai':
			return createOpenAI({
				...commonOpts,
			})(model);
		case 'anthropic':
			return createAnthropic({
				...commonOpts,
			})(model);
		case 'azure':
			return createAzure({
				...commonOpts,
			})(model);
		case 'google':
			return createGoogleGenerativeAI({
				...commonOpts,
			})(model);
		case 'amazon-bedrock':
			if (
				!process.env.AWS_REGION ||
				!process.env.AWS_ACCESS_KEY_ID ||
				!process.env.AWS_SECRET_ACCESS_KEY
			) {
				throw new Error(
					'amazon-bedrock provider only supports providing credentials through enviroment varibles. Please provide all env varibles (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)'
				);
			}
			return createAmazonBedrock()(model);
		case 'deepseek':
			return createDeepSeek({
				...commonOpts,
			})(model);
		default:
			throw new Error(`Unsupported llm provider: ${provider}`);
	}
};

/**
 * Default instructions given to the AI in order
 * to get file system like json blob back
 */
const FILE_SYSTEM_INSTRUCTIONS = `\
you are being used to generate code. Return a 1 dimension json 
array of objects in json format. Each object will have a "path" 
property holding a relative path to code you are generating files 
or directory which must start with "./",  a "type" property to determine 
if the object represents a "directory" or "file",  a "content" property for the 
content of the file but only on file objects. You only need to generate directory 
objects for directories that dont have corresponding child files/directories that are 
in the same array.
`;

/**
 * Created additional AI instructions
 *
 * @param {string[]} prompts
 * @returns {string}
 */
const createAdditionalPrompts = (prompts = []) => {
	if (!prompts.length) return '';

	const bulletPoints = prompts
		.map((prompt, i) => {
			return `${i + 1}.) ${prompt}`;
		})
		.join('\n');

	return `\
Follow these additional instructions:
${bulletPoints}
`;
};

/**
 * Get the files and folders that need to be created from the AI
 *
 * @param {Answers} options
 * @returns {Promise<FileSystem | null>}
 */
const getTemplateFromLLM = async (options) => {
	const system = [
		FILE_SYSTEM_INSTRUCTIONS,
		createAdditionalPrompts(options?.prompts ?? []),
	].join('\n');

	const { object } = await generateObject({
		model: getLanguageModel(options),
		schema: FileSystemSchema,
		system,
		prompt: options.build,
	});

	return object;
};

/**
 * Default models for each provider
 */
const defaultModels = {
	openai: 'gpt-4o-mini',
	anthropic: 'claude-3-haiku-20240307',
	azure: null,
	google: 'gemini-1.5-pro-latest',
	'amazon-bedrock': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
	deepseek: 'deepseek-chat',
};

const envMapping = {
	openai: 'OPENAI_API_KEY',
	anthropic: 'ANTHROPIC_API_KEY',
	azure: 'AZURE_API_KEY',
	google: 'GOOGLE_GENERATIVE_AI_API_KEY',
	deepseek: 'DEEPSEEK_API_KEY',
};

const getEnvVar = (provider) => {
	const envVar = envMapping[provider];
	return process.env[envVar] ?? null;
};
