import {DurableObject} from "cloudflare:workers";
export class JournalAgent extends DurableObject {async result(){return "日報エージェントのテスト結果";}async review(){return null;}}
export default {fetch(){return new Response("Not found",{status:404});}};
