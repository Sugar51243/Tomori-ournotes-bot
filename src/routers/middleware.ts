import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { logger } from '../logger';

export const middleware = (req: Request, res: Response, next: NextFunction) => {
    const requestTime = Date.now();
    logger('Request', `${req.ip} ${req.baseUrl}${req.path} ${JSON.stringify(req.body)}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger('Validation Failed', `${req.ip} ${req.baseUrl}${req.path} ${JSON.stringify(errors.array())}`);
        return res.status(400).send({ status: 'failed', data: `参数错误`, error: errors.array() });
    }

    const originalSend = res.send;
    let isLogged = false;
    res.send = function (body?: unknown) {
        if (!isLogged) {
            isLogged = true;
            const duration = Date.now() - requestTime;
            const size = Buffer.byteLength(JSON.stringify(body)) / 1024 / 1024;
            logger('Response', `${req.ip} ${req.baseUrl}${req.path} ${size.toFixed(2)}MB ${duration}ms`);
        }
        return originalSend.call(this, body);
    };

    next();
};
