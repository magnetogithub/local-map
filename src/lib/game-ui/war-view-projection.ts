import type {WarsViewModel} from "./contracts";

export function createWarsProjection(): WarsViewModel {
  return Object.freeze({
    dataAvailable: false,
    unavailableReason: "전쟁 도메인 연결 예정",
    wars: Object.freeze([]),
  });
}
