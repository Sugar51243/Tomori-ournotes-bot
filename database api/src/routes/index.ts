import { Router } from 'express';
import { opRouter } from './opRouter';
import { cutoffOps } from './cutoffRoutes';
import { usersOps } from './usersRoutes';
import { forumOps } from './forumRoutes';
import { chartsOps } from './chartsRoutes';
import { chatOps } from './chatRoutes';
import { noticesOps } from './noticesRoutes';
import { auditOps } from './auditRoutes';
import { songCacheOps } from './songCacheRoutes';
import { bindCodesOps } from './bindCodesRoutes';
import { accountsOps } from './accountsRoutes';
import { miscOps } from './miscRoutes';

/**
 * /v1 下的全部模块。每个模块一张 op 表, 挂成 POST /v1/<module>/<op>。
 * 新模块在这里登记。
 */
export const v1Router = Router();

v1Router.use('/cutoff', opRouter(cutoffOps));
v1Router.use('/users', opRouter(usersOps));
v1Router.use('/forum', opRouter(forumOps));
v1Router.use('/charts', opRouter(chartsOps));
v1Router.use('/chat', opRouter(chatOps));
v1Router.use('/notices', opRouter(noticesOps));
v1Router.use('/audit', opRouter(auditOps));
v1Router.use('/songCache', opRouter(songCacheOps));
v1Router.use('/bindCodes', opRouter(bindCodesOps));
v1Router.use('/accounts', opRouter(accountsOps));
v1Router.use('/misc', opRouter(miscOps));
