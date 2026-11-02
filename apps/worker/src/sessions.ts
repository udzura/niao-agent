export const LEGACY_SESSION = "legacy";
export const sessionLimits = {count:50, bytes:8*1024*1024, messages:2000, reserveBytes:768*1024};
export interface ChatSession {
  id:string; title:string; createdAt:string; updatedAt:string; lastActivityAt:string;
  archivedAt:string|null; epoch:number; messageCount?:number;
}
