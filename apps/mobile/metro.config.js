// Metro 打包配置。
// 打包缓存放在本项目目录里(默认在系统临时目录,几个工作区共用,会把别处的打包结果串进来——
// 比如把测试用的服务器地址带进正式包)。
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { FileStore } = require("metro-cache");

const config = getDefaultConfig(__dirname);
config.cacheStores = [new FileStore({ root: path.join(__dirname, ".metro-cache") })];
module.exports = config;
