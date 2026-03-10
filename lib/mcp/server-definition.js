import { SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION } from "../config.js";

export const MCP_SERVER_INFO = {
  name: "engram-mcp-server",
  version: "1.0.0"
};

export const MCP_SERVER_CAPABILITIES = {
  tools: { listChanged: false },
  prompts: { listChanged: false },
  resources: { listChanged: false, subscribe: false }
};

export function buildServerInstructions(protocolVersion = DEFAULT_PROTOCOL_VERSION) {
  return `# Engram MCP Server

연결 성공. Fragment-Based Memory 시스템.

## 세션 시작 시 필수 행동 (자동 실행)

1. context 도구를 즉시 호출하여 Core/Working Memory를 로드한다.
2. recall로 과거 해결 기록과 설정 결정을 먼저 확인한다.
3. 중요한 결정, 절차, 에러 해결이 확정되면 remember를 호출한다.
4. 세션이 끝날 때 reflect를 호출한다.

## 주요 도구

- remember
- recall
- forget
- link
- amend
- reflect
- context
- tool_feedback
- memory_stats
- memory_consolidate
- graph_explore
- fragment_history

프로토콜 버전: ${protocolVersion}
지원 버전: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`;
}

export function buildServerDescription(protocolVersion = DEFAULT_PROTOCOL_VERSION) {
  return `Engram MCP - Fragment-Based Memory Server

주요 기능:
- 파편 기반 기억 시스템 (Fragment-Based Memory)
- 3계층 검색 (Redis L1 → PostgreSQL L2 → pgvector L3) + RRF 하이브리드 병합
- 비동기 임베딩 + 자동 관계 생성
- 시간-의미 복합 랭킹 (anchorTime 기반)
- TTL 기반 기억 계층 관리 + 지수 감쇠

지원 프로토콜: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}
협상 프로토콜: ${protocolVersion}`;
}
