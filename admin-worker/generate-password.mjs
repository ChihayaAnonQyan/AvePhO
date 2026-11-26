import { createHash, randomBytes } from 'node:crypto';

const password = randomBytes(24).toString('base64url');
const verifier = createHash('sha256').update(password).digest('base64url');
console.log('后台登录密码（保存到自己的密码管理器）');
console.log(password);
console.log('\nADMIN_PASSWORD_SHA256（填入 Cloudflare Worker 的 Secret）');
console.log(verifier);
