import { createCardRouter } from './cardRoute';

/** 查角色卡: 仅查询成员卡(角色卡) */
export const searchMemberCardRouter = createCardRouter('member');
