const vscode = require("vscode");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const initSqlJs = require("sql.js");
const {
	extractUserIdFromJwt,
	getUsage,
	getFullStripeProfile,
	generateIds,
} = require("./utils/user.js");
const { updateMainJsContent } = require("./utils/mainjs.js");
const { extensionName } = require("./utils/name.js");
const { getCursorMainJsPath, getConfigPath } = require("./utils/cursorInfo.js");

let usageTimer = null; // 定时器变量

/**
 * 激活扩展时调用的方法
 * @param {vscode.ExtensionContext} context - VSCode扩展上下文
 */
function activate(context) {
	console.log(`Extension "${extensionName}" is now active!`);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			`${extensionName}.regenerateId`,
			handleRegenerateId,
		),
		vscode.commands.registerCommand(
			`${extensionName}.readToken`,
			handleReadToken,
		),
		vscode.commands.registerCommand(
			`${extensionName}.setToken`,
			handleSetToken,
		),
		vscode.commands.registerCommand(
			`${extensionName}.showUsage`,
			handleUsage,
		),
		vscode.commands.registerCommand(
			`${extensionName}.patchMachineId`,
			handlePatchMachineId,
		),
	);

	// 设置定时器
	setupTimer(context);

	// 监听配置变化
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(`${extensionName}.usageMonitor`)) {
				setupTimer(context);
			}
		}),
	);
}

/**
 * 更新设备ID并创建备份
 * @param {string} storagePath - 存储文件路径
 * @param {string} dbPath - 数据库文件路径
 * @param {string} [accessToken] - 可选的访问令牌
 */
async function updateDeviceIds(storagePath, dbPath, accessToken) {
	let db = null;
	let result = "";
	let oldIds = {};
	let newIds = {};
	try {
		// 创建备份
		await Promise.all([
			fs.copyFile(storagePath, `${storagePath}.backup`).catch(() => {}),
			fs.copyFile(dbPath, `${dbPath}.backup`).catch(() => {}),
		]);
		
		// 生成新ID
		const userId = accessToken ? extractUserIdFromJwt(accessToken) : "";
		newIds = generateIds(userId);

		try {
			// 写入 devDeviceId 到 machineid 文件
			const machineIdPath = path.join(
				path.dirname(path.dirname(path.dirname(storagePath))),
				"machineid",
			);
			await fs.writeFile(machineIdPath, newIds.devDeviceId, "utf8");
		} catch {
			// 忽略任何路径计算或写入过程中的错误
			console.log("写入 machineid 文件失败, 继续执行...");
		}

		// 更新JSON配置
		const jsonConfig = JSON.parse(await fs.readFile(storagePath, "utf8"));
		oldIds = Object.fromEntries(
			Object.keys(newIds).map(
				(key) => [key, jsonConfig[`telemetry.${key}`] || "无"],
			),
		);
		Object.entries(newIds).forEach(([key, value]) => {
			jsonConfig[`telemetry.${key}`] = value;
		});
		await fs.writeFile(storagePath, JSON.stringify(jsonConfig, null, 2));

		// 更新数据库
		const SQL = await initSqlJs();
		const dbBuffer = await fs.readFile(dbPath);
		db = new SQL.Database(dbBuffer);

		// 更新设备ID
		db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [
			newIds.devDeviceId,
			"storage.serviceMachineId",
		]);

		// 处理认证信息和会员类型
		const updates = [
			['cursorAuth/accessToken', accessToken || ""],
			['cursorAuth/refreshToken', accessToken || ""],
			[
				'cursorAuth/cachedEmail',
				accessToken ? (userId || 'admin@cursor.sh') : "",
			],
			['cursorAuth/cachedSignUpType', accessToken ? "Auth_0" : ""],
			['cursorAuth/stripeMembershipType', accessToken ? "pro" : "free"],
		];

		updates.forEach(([key, value]) => {
            const exists = db.exec("SELECT 1 FROM ItemTable WHERE key = ?", [key]);
            if (exists.length === 0) {
                db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [key, value]);
            } else {
                db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [value, key]);
            }
        });

		// 保存数据库文件
		const data = db.export();
		await fs.writeFile(dbPath, Buffer.from(data));

		result += accessToken
			? "✅ 数据库更新成功\n✅ Token已更新\n"
			: "✅ 数据库更新成功\n✅ 认证信息已清空\n✅ 请启动后重新登录";
	} catch (error) {
		console.error("更新失败:", error);
		result += "❌ 更新失败: " + error.message;
	} finally {
		if (db) db.close();
		// 显示结果并退出
		await vscode.window.showInformationMessage(
			Object.entries(newIds)
				.map(([key, value]) =>
					`${key}:\n旧: ${oldIds[key]}\n新: ${value}`
				)
				.join("\n\n") +
				"\n\n数据库状态:\n" + result +
				"\n\n✅ 操作已完成, Cursor 将立即退出",
			{ modal: true },
		).then(() => {
			// 使用 process.exit() 强制退出
			vscode.commands.executeCommand("workbench.action.quit").then(() => {
				setTimeout(() => process.exit(0), 100);
			});
		});
	}
}

/**
 * 从数据库获取 token
 * @returns {Promise<string>} token
 * @throws {Error} 当未找到 token 或数据库操作失败时
 */
async function getTokenFromDb() {
	const paths = await getConfigPath();
	const SQL = await initSqlJs();
	const dbBuffer = await fs.readFile(paths.dbPath);
	const db = new SQL.Database(dbBuffer);

	try {
		const result = db.exec(
			'SELECT value FROM ItemTable WHERE key = "cursorAuth/accessToken"',
		);
		if (
			!result.length || !result[0].values.length ||
			!result[0].values[0][0]
		) {
			throw new Error("未找到 Access Token, 检查是否未登录");
		}
		return result[0].values[0][0];
	} finally {
		db.close();
	}
}

/**
 * 设置定时器
 */
function setupTimer(context) {
	const config = vscode.workspace.getConfiguration(
		`${extensionName}.usageMonitor`,
	);
	const interval = Math.floor(config.get("checkInterval") ?? 0);
	const remainingLimit = Math.floor(
		config.get("usageRemainingThreshold") ?? 0,
	);
	const usageLimit = Math.floor(config.get("usageCountThreshold") ?? 0);

	// 如果间隔小于20秒或未设置，不启动定时器, 限制间隔在20秒到24小时之间
	if (interval < 20) return;
	const validInterval = Math.max(20, Math.min(1440 * 60, interval)) * 1000;

	if (usageTimer) clearInterval(usageTimer);

	let isRunning = false;
	usageTimer = setInterval(async () => {
		if (isRunning) return;
		isRunning = true;
		try {
			const token = await getTokenFromDb();
			const usage = await getUsage(token);
			const remaining = usage.max_premium_usage - usage.premium_usage;

			const alerts = [];
			if (remainingLimit > 0 && remaining <= remainingLimit) {
				alerts.push(`剩余次数不足 ${remaining} 次`);
			}
			if (usageLimit > 0 && usage.premium_usage >= usageLimit) {
				alerts.push(`已使用 ${usage.premium_usage} 次`);
			}

			if (alerts.length > 0) {
				vscode.window.showWarningMessage(
					`${extensionName}: ${alerts.join(", ")}`,
				);
				await handleUsage();
			}
		} catch (err) {
			console.error("Timer check failed:", err);
		} finally {
			isRunning = false;
		}
	}, validInterval);

	context.subscriptions.push({
		dispose: () => {
			if (usageTimer) {
				clearInterval(usageTimer);
				usageTimer = null;
			}
		},
	});
}

/**
 * 处理重新生成设备ID的命令
 */
async function handleRegenerateId() {
	try {
		const confirm = await vscode.window.showWarningMessage(
			"此操作将重新生成设备ID并清空认证信息, 是否继续？",
			{
				modal: true,
				detail: "将会备份原有配置文件, 但建议手动备份以防万一. ",
			},
			"继续",
			"取消",
		);

		if (confirm !== "继续") {
			console.log("操作已取消");
			return;
		}

		const paths = await getConfigPath();
		await updateDeviceIds(paths.storagePath, paths.dbPath);
	} catch (error) {
		vscode.window.showErrorMessage(`操作失败: ${error.message}`);
		console.error("详细错误:", error);
	}
}

/**
 * 处理获取Token的命令
 */
async function handleReadToken() {
	try {
		const token = await getTokenFromDb();
		vscode.window.showInformationMessage(`Access Token: ${token}`);
	} catch (error) {
		vscode.window.showErrorMessage(`操作失败: ${error.message}`);
		console.error("详细错误:", error);
	}
}

/**
 * 处理设置Token的命令
 */
async function handleSetToken(token) {
	try {
		if (!token) {
			token = await vscode.window.showInputBox({
				prompt: "请输入 Access Token",
				password: true,
				placeHolder: "输入 Access Token",
			});
		}

		if (!token) {
			console.log("操作已取消");
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			"此操作将重新生成设备ID并设置新的Token, 是否继续？",
			{
				modal: true,
				detail: "将会备份原有配置文件, 但建议手动备份以防万一. ",
			},
			"继续",
			"取消",
		);

		if (confirm !== "继续") {
			console.log("操作已取消");
			return;
		}

		const paths = await getConfigPath();
		await updateDeviceIds(paths.storagePath, paths.dbPath, token);
	} catch (error) {
		vscode.window.showErrorMessage(`操作失败: ${error.message}`);
		console.error("详细错误:", error);
	}
}

/**
 * 处理使用情况
 */
async function handleUsage() {
	try {
		let result = "";
		const token = await getTokenFromDb();
		const usage = await getUsage(token);
		result +=
			`Premium Usage: ${usage.premium_usage}/${usage.max_premium_usage}; \n`;
		result +=
			`Basic Usage: ${usage.basic_usage}/${usage.max_basic_usage}; \n`;

		// 获取完整的 Stripe 用户信息
		const profile = await getFullStripeProfile(token);
		result += `Membership Type: ${profile.membershipType}; \n`;
		result +=
			`Days Remaining on Trial: ${profile.daysRemainingOnTrial}; \n`;

		// 显示信息
		// vscode.window.showInformationMessage(result, { modal: true }); // 弹窗, 但不好看
		vscode.window.showInformationMessage(result); // 无感 Message, 舒服
		console.log(result);
	} catch (error) {
		vscode.window.showErrorMessage(`获取使用情况时出错: ${error.message}`);
		console.error("获取使用情况时出错:", error);
	}
}

/**
 * 修补机器码获取逻辑
 */
async function handlePatchMachineId() {
	try {
		const confirm = await vscode.window.showWarningMessage(
			"即将修补 Cursor 机器码获取逻辑",
			{
				modal: true,
				detail: "功能: 修补 Cursor 0.45.x 版本机器码的获取方式\n\n" +
					"⚠️ 注意事项:\n" +
					"  1. 此操作将修补 Cursor 的 main.js 文件, 仅需执行一次\n" +
					"  2. 修补后需要重启 Cursor 才能生效\n" +
					"  3. 操作不可逆，建议提前备份文件\n" +
					"  4. 直接覆盖安装可恢复\n" +
					"  5. 升级后需要再次执行\n" +
					"\n确认要继续吗? ",
			},
			"继续修补",
		);

		if (confirm !== "继续修补") {
			return;
		}

		await updateMainJsContent(await getCursorMainJsPath());

		await vscode.window.showInformationMessage(
			"✅ main.js 修补成功, Cursor 将立即退出",
			{ modal: true }
		).then(() => {
			vscode.commands.executeCommand('workbench.action.quit').then(() => {
				setTimeout(() => process.exit(0), 100);
			});
		});

	} catch (error) {
		vscode.window.showErrorMessage(`修补 main.js 失败: ${error.message}`);
		console.error("详细错误:", error);
	}
}

function deactivate() {
	if (usageTimer) {
		clearInterval(usageTimer);
		usageTimer = null;
	}
}

module.exports = { activate, deactivate };
