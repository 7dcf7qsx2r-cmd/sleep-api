import { config } from "../config.js";

export type IotDownlinkPublisher = (input: {
  productKey: string;
  sn: string;
  payload: unknown;
}) => Promise<{ topic: string }>;

let publisher: IotDownlinkPublisher | null = null;

export function setIotDownlinkPublisher(fn: IotDownlinkPublisher | null): void {
  publisher = fn;
}

export class IotDownlinkError extends Error {
  constructor(
    public readonly code: "unavailable" | "rejected",
    message: string,
  ) {
    super(message);
    this.name = "IotDownlinkError";
  }
}

async function defaultHttpPublish(input: {
  productKey: string;
  sn: string;
  payload: unknown;
}): Promise<{ topic: string }> {
  const base = config.mqttControl.url.replace(/\/$/, "");
  const token = config.mqttControl.adminToken;
  if (!base || !token) {
    throw new IotDownlinkError("unavailable", "云端控制未配置");
  }
  let res: Response;
  try {
    res = await fetch(`${base}/v1/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        productKey: input.productKey,
        sn: input.sn,
        payload: input.payload,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new IotDownlinkError("unavailable", "无法连接 MQTT 控制通道");
  }
  const body = await res.json().catch(() => ({})) as { topic?: string; message?: string; error?: string };
  if (!res.ok) {
    throw new IotDownlinkError(
      res.status >= 500 ? "unavailable" : "rejected",
      body.message || "下行发布失败",
    );
  }
  return { topic: typeof body.topic === "string" ? body.topic : "" };
}

export async function publishIotDownlink(input: {
  productKey: string;
  sn: string;
  payload: unknown;
}): Promise<{ topic: string }> {
  const fn = publisher ?? defaultHttpPublish;
  return fn(input);
}
