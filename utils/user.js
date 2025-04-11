const fetch = require('node-fetch');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');


// 从JWT中提取用户ID
function extractUserIdFromJwt(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        const match = payload.sub?.match(/auth0\|(.+)/);
        return match ? match[1] : '';
    } catch {
        return '';
    }
}

/**
 * 获取 cursor 的使用情况
 * @param {string} token - cursor 的 JWT 令牌
 * @returns {Promise<Object>} - 包含 Cursor 使用情况的 JSON 对象
 */
async function getUsage(token) {
	const response = await fetch(`https://www.cursor.com/api/usage`, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			"Cookie": `WorkosCursorSessionToken=user_01OOOOOOOOOOOOOOOOOOOOOOOO%3A%3A${token}`
		}
	});
	const data = await response.json();
	return {
		premium_usage: data["gpt-4"]?.numRequestsTotal || 0,
		max_premium_usage: data["gpt-4"]?.maxRequestUsage || 999,
		basic_usage: data["gpt-3.5-turbo"]?.numRequestsTotal || 0,
		max_basic_usage: data["gpt-3.5-turbo"]?.maxRequestUsage || 999,
	};
}

/**
 * 获取完整的 Stripe 用户信息
 * @param {string} token - cursor 的 JWT 令牌
 * @returns {Promise<Object>} - 包含 Stripe 用户信息的 JSON 对象
 */
async function getFullStripeProfile(token) {
	const response = await fetch(`https://api2.cursor.sh/auth/full_stripe_profile`, {
		headers: {

			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			"Authorization": `Bearer ${token}`
		}
	});
	return response.json();
}

/**
 * 生成设备ID
 * @param {string} userId - 用户ID
 * @returns {string} 设备ID
 */
function generateDeviceUUID(userId) {
    const hash = crypto.createHash('md5').update(userId).digest('hex');
    return hash.replace(/(.{8})(.{4})(.{3})(.{3})(.{12})/, '$1-$2-3$3-8$4-$5');
}

function generateIds(userId){
	const generateId = userId ? userId : uuidv4();
	const devDeviceId = generateDeviceUUID(generateId);
	return {
		devDeviceId: devDeviceId,
		machineId: crypto.createHash('sha256').update(generateId).digest('hex'),
		sqmId: `{${devDeviceId.toUpperCase()}}`,
		macMachineId: crypto.createHash('sha256').update(generateId + generateId).digest('hex')
	};
}

module.exports = {
    extractUserIdFromJwt,
    getUsage,
	getFullStripeProfile,
	generateIds

};