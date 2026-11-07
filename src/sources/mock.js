import { EventEmitter } from 'node:events';
import { makeEvent } from '../bus.js';
import { avatarFor } from '../avatar.js';

const NAMES = [
  '小红薯爱吃瓜', '柠檬不酸', '一只柯基', '深夜煮泡面', '南风知我意', '橘子汽水',
  'momo', '摸鱼达人', '不加香菜', '阿柚柚', '今天也很困', '海边散步',
  '芝士就是力量', '小熊软糖', '深夜书店', '橙子可以', '半糖去冰', '七月流火',
];

const COMMENTS = [
  '主播好厉害！', '这个颜色好好看', '求链接', '已下单', '价格还能再低点吗',
  '第一次来，关注了', '画质好清晰', '主播声音好好听', '什么时候上架',
  '666', '来了来了', '这个我也买了，很好用', '求试色', '能再讲一遍吗',
  '刚刚没抢到', '主播今天播到几点', '蹲一个福利', '已三连',
];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * 本地假数据源：不联网、不登录，用于调样式和演示
 * 开启后按 0.6~2.2 秒的随机间隔灌事件
 */
export class MockSource extends EventEmitter {
  constructor(bus) {
    super();
    this.bus = bus;
    this.timer = null;
    this.status = {
      running: false,
      state: 'idle',
      message: '',
      frames: 0,
      events: 0,
      unknownTypes: {},
      lastFrameAt: 0,
      startedAt: 0,
      browserPath: '（mock，不使用浏览器）',
      pageUrl: '',
      sockets: 0,
    };
    this._seq = 0;
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit('status', this.status);
  }

  async start() {
    if (this.status.running) return this.status;
    this.setStatus({
      running: true,
      state: 'capturing',
      message: 'mock 数据源运行中（不联网）',
      startedAt: Date.now(),
      frames: 0,
      events: 0,
      unknownTypes: {},
    });
    this._loop();
    return this.status;
  }

  _loop() {
    clearTimeout(this.timer);
    const delay = 600 + Math.random() * 1600;
    this.timer = setTimeout(() => {
      if (!this.status.running) return;
      this.emitOne();
      this._loop();
    }, delay);
  }

  emitOne() {
    this._seq += 1;
    const roll = Math.random();
    let kind = 'comment';
    if (roll > 0.94) kind = 'gift';
    else if (roll > 0.86) kind = 'follow';
    else if (roll > 0.76) kind = 'enter';
    else if (roll > 0.72) kind = 'like';

    const name = rand(NAMES);
    const user = {
      id: `mock-${Math.floor(Math.random() * 40)}`,
      name,
      avatar: avatarFor(name),
      role: 0,
    };
    const now = Date.now();
    const patch = { kind, ts: now, user, id: `mock-${this._seq}-${now}` };

    if (kind === 'comment') patch.text = rand(COMMENTS);
    if (kind === 'gift') patch.gift = { name: rand(['小红花', '棒棒糖', '跑车']), count: 1 + Math.floor(Math.random() * 5) };
    if (kind === 'like') patch.count = 1 + Math.floor(Math.random() * 9);

    const event = makeEvent(patch);
    this.bus.push(event);
    this.setStatus({ events: this.status.events + 1, frames: this.status.frames + 1, lastFrameAt: now });
  }

  async stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.setStatus({ running: false, state: 'idle', message: '已停止' });
  }

  async openLogin() {
    throw new Error('mock 模式不需要登录');
  }

  async reload() {
    /* noop */
  }

  async bringToFront() {
    /* noop */
  }
}
