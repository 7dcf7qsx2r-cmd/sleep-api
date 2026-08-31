const CIS_PRODUCT_KEYS = new Set(["cis_ib", "cis_iswb", "cis_ip"]);

export const CIS_COMMAND_WHITELIST: Record<string, ReadonlySet<string>> = {
  cis_ib: new Set(["setPressure", "setMotor", "setSnoreStatus", "socketStatus", "setRegularTime"]),
  cis_iswb: new Set([
    "setPressure",
    "setAirbagsMode",
    "setMemoryPressure",
    "setHeat",
    "socketStatus",
    "setSleepMaxPressure",
  ]),
  cis_ip: new Set([
    "setPressure",
    "setSnoreStatus",
    "setSnoreSensitivity",
    "setAiSleep",
    "setHeating",
    "socketStatus",
    "setSupplementTime",
    "setTimeRange",
    "setRegularTime",
    "stopMorning",
  ]),
};

export function buildServiceInvokePayload(
  service: string,
  params: Record<string, unknown>,
): { method: "thing.service.invoke"; params: Record<string, Record<string, unknown>> } {
  return {
    method: "thing.service.invoke",
    params: { [service]: params },
  };
}

export type CommandValidation =
  | { ok: true; payload: ReturnType<typeof buildServiceInvokePayload> }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intField(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} 须为整数`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} 超出范围 ${min}–${max}`);
  }
  return value;
}

function numField(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} 须为数字`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} 超出范围 ${min}–${max}`);
  }
  return value;
}

function flag01(value: unknown, name: string): number {
  return intField(value, 0, 1, name);
}

function validateServiceParams(
  productKey: string,
  service: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  switch (service) {
    case "socketStatus":
      return { status: flag01(params.status, "status") };
    case "setPressure": {
      if (productKey === "cis_ib") {
        return {
          num: intField(params.num, 1, 8, "num"),
          pressure: numField(params.pressure, 1000, 8000, "pressure"),
        };
      }
      if (productKey === "cis_iswb") {
        return {
          num: intField(params.num, 1, 2, "num"),
          pressure: numField(params.pressure, 800, 12_000, "pressure"),
        };
      }
      return {
        num: intField(params.num, 0, 1, "num"),
        pressure: numField(params.pressure, 800, 8000, "pressure"),
      };
    }
    case "setMotor": {
      const num = intField(params.num, 1, 3, "num");
      const maxHeight = num === 2 ? 2250 : 3150;
      return { num, height: intField(params.height, 0, maxHeight, "height") };
    }
    case "setSnoreStatus": {
      if (productKey === "cis_ib") {
        return {
          status: flag01(params.status, "status"),
          sensitivity: intField(params.sensitivity, 3, 9, "sensitivity"),
          bedSide: flag01(params.bedSide, "bedSide"),
          height: intField(params.height, 0, 2300, "height"),
        };
      }
      return { snoreStatus: flag01(params.snoreStatus, "snoreStatus") };
    }
    case "setSnoreSensitivity":
      return {
        snoreSensitivity: intField(params.snoreSensitivity, 3, 9, "snoreSensitivity"),
        snoreMode: intField(params.snoreMode, 0, 2, "snoreMode"),
      };
    case "setAiSleep":
      return {
        sleepStall: intField(params.sleepStall, 0, 2, "sleepStall"),
        duration: intField(params.duration, 0, 60, "duration"),
        sleepLowTime: intField(params.sleepLowTime, 0, 8, "sleepLowTime"),
        sleepHeightTime: intField(params.sleepHeightTime, 0, 8, "sleepHeightTime"),
      };
    case "setHeating":
      return {
        heatingStatus: flag01(params.heatingStatus, "heatingStatus"),
        heatingLevel: intField(params.heatingLevel, 0, 2, "heatingLevel"),
      };
    case "setAirbagsMode":
      if (params.mode !== 2 && params.mode !== 5) {
        throw new Error("mode 须为 2（助眠）或 5（抽气）");
      }
      return {
        bedSide: flag01(params.bedSide, "bedSide"),
        mode: params.mode,
        duration: intField(params.duration, 0, 180, "duration"),
      };
    case "setMemoryPressure":
      return {
        bedSide: flag01(params.bedSide, "bedSide"),
        action: flag01(params.action, "action"),
      };
    case "setHeat":
      return {
        bedSide: flag01(params.bedSide, "bedSide"),
        enable: flag01(params.enable, "enable"),
        level: intField(params.level, 0, 2, "level"),
      };
    case "setSleepMaxPressure":
      return {
        sleepMaxPressure: numField(
          params.sleepMaxPressure ?? params.pressure,
          6000,
          12_000,
          "sleepMaxPressure",
        ),
      };
    case "stopMorning":
      if (params.enable !== 1) {
        throw new Error("enable 须为 1");
      }
      return { enable: 1 };
    case "setSupplementTime":
      return { supplementTime: intField(params.supplementTime, 0, 24, "supplementTime") };
    case "setTimeRange":
      return {
        status: flag01(params.status, "status"),
        starthour: intField(params.starthour, 0, 23, "starthour"),
        startminute: intField(params.startminute, 0, 59, "startminute"),
        endhour: intField(params.endhour, 0, 23, "endhour"),
        endminute: intField(params.endminute, 0, 59, "endminute"),
      };
    case "setRegularTime": {
      if (productKey !== "cis_ib") return params;
      const week = params.weekDayTime;
      if (!Array.isArray(week) || week.length < 9) {
        throw new Error("weekDayTime 须含星期与时刻");
      }
      const weekDayTime = week.slice(0, 9).map((value, index) => {
        if (index < 7) return flag01(value, `weekDayTime[${index}]`);
        if (index === 7) return intField(value, 0, 23, "hour");
        return intField(value, 0, 59, "minute");
      });
      return {
        weekDayTime,
        enable: flag01(params.enable, "enable"),
        bedSide: flag01(params.bedSide ?? 0, "bedSide"),
      };
    }
    default:
      throw new Error(`不支持 ${service}`);
  }
}

export function validateCisServiceCommand(
  productKey: string,
  service: string,
  params: unknown,
): CommandValidation {
  if (!CIS_PRODUCT_KEYS.has(productKey)) {
    return { ok: false, message: "该机型不支持云端控制" };
  }
  const allowed = CIS_COMMAND_WHITELIST[productKey];
  if (!allowed?.has(service)) {
    return { ok: false, message: `该机型不支持 ${service}` };
  }
  if (!isPlainObject(params)) {
    return { ok: false, message: "params 必须是对象" };
  }
  try {
    const sanitized = validateServiceParams(productKey, service, params);
    return { ok: true, payload: buildServiceInvokePayload(service, sanitized) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "参数无效" };
  }
}
