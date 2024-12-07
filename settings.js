// @ts-check

const { OpenAI } = require("openai");
const { zodResponseFormat } = require("openai/helpers/zod");
const z = require("zod");
const fs = require("fs/promises");
const path = require("path");

const FileSystemObjectSchema = z
  .object({
    path: z.string({
      description:
        "Relative path to the file or directoryn that starts with './'",
    }),
    type: z.enum(["directory", "file"], {
      description: "Type of file system object. either file or directory",
    }),
    content: z.string({ description: "File object contents" }),
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

/** @type {import('templates-mo/lib/types/settings').SettingsFile} */
module.exports = {
  prompts: [
    {
      name: "build",
      description: "Description of what you want to intruct the llm to build",
      message: "What would you like to build?",
      tpsType: "data",
      type: "input",
    },
    {
      name: "llm",
      description: "Type of llm you want to use",
      tpsType: "data",
      type: "list",
      message: "What type of llm do you want to use?",
      choices: ["openai", "anthropic", "huggingface"],
      default: "openai",
    },
    {
      name: "token",
      description: "Api token for llm Api",
      tpsType: "data",
      type: "input",
      message: "Enter your api token for the llm",
      default: null,
    },
  ],
  events: {
    async onRender(tps, { dest, buildPaths }) {
      const answers = tps.getAnswers();

      const fileSystem = await getTemplateFromLLM(
        answers.llm,
        answers.build,
        answers.token
      );

      if (!fileSystem) {
        throw new Error("LLM didnt return a valid response");
      }

      return Promise.all(
        buildPaths.map((buildPath) => {
          return generateFileContent(
            buildPath,
            fileSystem,
            tps.opts.force || tps.opts.wipe
          );
        })
      );
    },
  },
};

/**
 * @returns {Promise<FileSystem | null>}
 */
const getTemplateFromLLM = async (apiType, inputPrompt, token) => {
  const openai = new OpenAI({ apiKey: token });

  console.log("Generating llm response...");

  switch (apiType) {
    case "openai":
      const completion = await openai.beta.chat.completions.parse({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `\
				you are being used to generate code. Return a 1 dimension json 
				array of objects in json format. Each object will have a "path" 
				property holding a relative path to code you are generating files 
				or directory which must start with "./",  a "type" property to determine 
				if the object represents a "directory" or "file",  a "content" property for the 
				content of the file but only on file objects. You only need to generate directory 
				objects for directories that dont have corresponding child files/directories that are 
				in the same array.`,
          },
          {
            role: "user",
            content: inputPrompt,
          },
        ],
        response_format: zodResponseFormat(FileSystemSchema, "file_system"),
      });

      return completion.choices[0].message.parsed;

    // case "anthropic":
    //   response = await fetch("https://api.anthropic.com/v1/complete", {
    //     method: "POST",
    //     headers: {
    //       "Content-Type": "application/json",
    //       Authorization: `Bearer ${token}`,
    //     },
    //     body: JSON.stringify({
    //       model: "claude-v1",
    //       prompt: inputPrompt,
    //       max_tokens: 300,
    //     }),
    //   });
    //   return (await response.json()).completion;

    // case 'huggingface':
    // 	response = await fetch(
    // 		'https://api-inference.huggingface.co/models/YOUR_MODEL',
    // 		{
    // 			method: 'POST',
    // 			headers: {
    // 				Authorization: `Bearer ${token}`,
    // 			},
    // 			body: JSON.stringify({ inputs: inputPrompt }),
    // 		},
    // 	);
    // 	return (await response.json())[0].generated_text;

    default:
      throw new Error("Unsupported API type");
  }
};

/**
 * @param {FileSystem} fileSystem
 */
const generateFileContent = async (dest, fileSystem, force = false) => {
  console.log("Generating file content...");
  for (const fileOrDir of fileSystem.fileContents) {
    const filePath = path.join(dest, fileOrDir.path);
    if (fileOrDir.type === "directory") {
      await fs.mkdir(filePath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, fileOrDir.content, {
        flag: force ? "wx" : "w",
      });
    }
  }
};
