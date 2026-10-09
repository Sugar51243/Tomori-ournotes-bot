/**
 * 鉴权中间件认出的消费方名字(bot / web / …), 供限流分桶与日志使用。
 */
declare global {
    namespace Express {
        interface Request {
            dbClient?: string;
        }
    }
}

export {};
