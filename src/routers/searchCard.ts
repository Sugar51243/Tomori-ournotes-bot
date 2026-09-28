import { createCardRouter, commandCard } from './cardRoute';

/**
 * 查卡(整合): 角色卡(成员卡)与支援卡一起查询。
 * 列表结果按种类分区显示; 按 ID 查询时默认先按角色卡再按支援卡, 可用 cardType 指定。
 */
export const searchCardRouter = createCardRouter('auto', true);
export { commandCard };
