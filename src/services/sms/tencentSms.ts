import { sms } from 'tencentcloud-sdk-nodejs-sms';
import { config } from '../../config.js';

const SmsClient = sms.v20210111.Client;

let client: InstanceType<typeof SmsClient> | null = null;

function getClient() {
  if (client) return client;
  if (!config.sms.secretId || !config.sms.secretKey) {
    throw new Error('SMS credentials not configured');
  }
  client = new SmsClient({
    credential: {
      secretId: config.sms.secretId,
      secretKey: config.sms.secretKey,
    },
    region: config.sms.region,
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } },
  });
  return client;
}

export async function sendVerificationSms(phoneE164: string, code: string): Promise<void> {
  if (config.sms.mock) {
    console.log(`[sms:mock] ${phoneE164} code=${code}`);
    return;
  }

  const c = getClient();
  const ttlMinutes = String(Math.ceil(config.sms.codeTtlSec / 60));
  const resp = await c.SendSms({
    PhoneNumberSet: [phoneE164],
    SmsSdkAppId: config.sms.sdkAppId,
    SignName: config.sms.signName,
    TemplateId: config.sms.templateId,
    TemplateParamSet: [code, ttlMinutes],
  });

  const status = resp.SendStatusSet?.[0];
  if (!status || status.Code !== 'Ok') {
    const msg = status?.Message ?? 'SendSms failed';
    throw new Error(`Tencent SMS: ${msg}`);
  }
}

export function isSmsConfigured(): boolean {
  return (
    config.sms.mock ||
    Boolean(
      config.sms.secretId &&
        config.sms.secretKey &&
        config.sms.sdkAppId &&
        config.sms.signName &&
        config.sms.templateId,
    )
  );
}
