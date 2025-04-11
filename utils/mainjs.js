const fs = require("fs").promises;
const vscode = require("vscode");
const { getCursorVersion } = require("./cursorInfo.js");

const patchMinVersion = "0.45.0";
const patchMaxVersion = "0.46.11";

function isVersionInRange(version, minVersion, maxVersion) {
    const compare = (v1, v2) => {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const num1 = parts1[i] || 0;
            const num2 = parts2[i] || 0;
            if (num1 !== num2) return num1 < num2;
        }
        return false;
    };

    return !compare(version, minVersion) && (compare(version, maxVersion) || version === maxVersion);
}

/**
 * 修补 main.js 文件内容
 * @param {string} filePath - main.js 文件路径
 */
async function updateMainJsContent(filePath) {
    const cursorVersion = await getCursorVersion();
    if (cursorVersion === "unknown" || !isVersionInRange(cursorVersion, patchMinVersion, patchMaxVersion)) {
        const message = `当前 Cursor 版本 ${cursorVersion} 不在修补范围 ${patchMinVersion} - ${patchMaxVersion} 内, 是否仍要继续修补？`;
        
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            "继续修补",
        );

        if (choice !== "继续修补") {
            throw new Error("操作已取消");
        }
    }

    let content = await fs.readFile(filePath, "utf8");
    await fs.writeFile(`${filePath}.backup`, content); // 创建备份

    [
        [
            /async\s+(\w+)\s*\(\)\s*{\s*return\s+this\.[\w.]+\?\?\s*this\.([\w.]+)\.machineId\s*}/g,
            (_, fname, prop) =>
                `async ${fname}() { return this.${prop}.machineId }`,
        ],
        [
            /async\s+(\w+)\s*\(\)\s*{\s*return\s+this\.[\w.]+\?\?\s*this\.([\w.]+)\.macMachineId\s*}/g,
            (_, fname, prop) =>
                `async ${fname}() { return this.${prop}.macMachineId }`,
        ],
    ].forEach(([pattern, replacer]) => {
        content = content.replace(pattern, replacer);
    });

    await fs.writeFile(filePath, content);
}

module.exports = {
    updateMainJsContent,
};
