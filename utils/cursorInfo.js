const vscode = require("vscode");
const { extensionName } = require("./name.js");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const pathExists = async (path) => {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * 获取Cursor版本号, eg: 0.46.11
 * @returns {string} 版本号
 */
function getCursorVersion() {
    return globalThis._VSCODE_PACKAGE_JSON?.version || "unknown";
}

/**
 * 获取Cursor可执行文件路径
 * @returns {string} 可执行文件路径
 */
function getCursorExePath() {
    return process.execPath || "unknown";
}

/**
 * 获取Cursor资源路径
 * @returns {string} 资源路径
 */
function getCursorResourcesPath() {
    return process.resourcesPath || "unknown";
}

/**
 * 获取Cursor的main.js路径
 * @returns {string} main.js路径
 * @throws {Error} 当系统为 Linux 时抛出错误
 */
async function getCursorMainJsPath() {
    const platform = os.platform();
    if (platform === "linux") {
        throw new Error("Linux 系统不支持修补 main.js");
    }
    let errorInfo = '';
    const config = vscode.workspace.getConfiguration(extensionName);
    let mainJsPath;
    mainJsPath = config.get("mainJsPath");
    if (mainJsPath) {
        errorInfo = `main.js 文件不存在, 配置的"mainJsPath: ${mainJsPath}"不存在`;
    } else {
        mainJsPath = path.join(getCursorResourcesPath(), "app", "out", "main.js");
        errorInfo = `main.js 文件不存在, 默认路径"${mainJsPath}"不存在`;
    }
    if (!await pathExists(mainJsPath)) {
        const choice = await vscode.window.showInformationMessage(
            errorInfo,
            "手动选择文件",
        );

        if (choice !== "手动选择文件") {
            throw new Error("操作已取消");
        }

        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                "JavaScript": ["js"],
            },
            title: "选择 main.js 文件",
        });

        if (!fileUri?.length) {
            throw new Error("未选择文件");
        }

        mainJsPath = fileUri[0].fsPath;
    }
    return mainJsPath;
}

async function checkStoragePaths(storage, db) {
    const storageExists = await pathExists(storage);
    const dbExists = await pathExists(db);

    if (!storageExists || !dbExists) {
        const missingFiles = [
            !storageExists && "storage.json",
            !dbExists && "state.vscdb",
        ].filter(Boolean).join(" 和 ");
        throw new Error(`所选文件夹中缺少: ${missingFiles}`);
    }

    return { storagePath: storage, dbPath: db };
}

/**
 * 获取存储文件的路径
 * @returns {Promise<{storagePath: string, dbPath: string}>} 返回存储文件和数据库的路径
 */
async function getConfigPath() {
	const config = vscode.workspace.getConfiguration(extensionName);
	const customGlobalStorage = config.get("storagePath");

	const globalStorage = customGlobalStorage || path.join(
		os.homedir(),
		...{
			"win32": ["AppData", "Roaming"],
			"darwin": ["Library", "Application Support"],
			"linux": [".config"],
		}[os.platform()] || (() => {
			throw new Error("不支持的操作系统");
		})(),
		"Cursor",
		"User",
		"globalStorage",
	);

    let storagePath, dbPath;
    storagePath = path.join(globalStorage, "storage.json")
    dbPath = path.join(globalStorage, "state.vscdb")

    try {
		return await checkStoragePaths(storagePath, dbPath);
	} catch (error) {
		const choice = await vscode.window.showInformationMessage(
			error.message,
			"手动选择globalStorage文件夹",
		);
		if (choice !== "手动选择globalStorage文件夹") {
			throw new Error("操作已取消");
		}
		const fileUri = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: "选择配置文件所在文件夹(globalStorage)",
		});
		if (!fileUri?.length) {
			throw new Error("未选择文件夹");
		}
		const selectedDir = fileUri[0].fsPath;

		return await checkStoragePaths(path.join(selectedDir, "storage.json"), path.join(selectedDir, "state.vscdb"));
	}
}


module.exports = {
    getCursorVersion,
    // getCursorExePath,
    // getCursorResourcesPath,
    getCursorMainJsPath,
    getConfigPath
};


