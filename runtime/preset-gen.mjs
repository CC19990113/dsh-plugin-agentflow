// preset-gen.mjs —— 把 AgentFlow 画布编译成 DSH agent preset。
//
// 纯函数 + 零依赖：输入 board，输出一段「让主 agent 用 subagent 分层下发子 agent」的
// 中文人格（persona），以及一个可安装的 plugin bundle：
//
//   package.json      声明 dsh.bundle.patch -> ./cordis.patch.yml
//   cordis.patch.yml  注册 preset-flow-<slug>（persona + 完整插件清单）
//   README.md         用途 / 安装 / 卸载
//
// 三条硬约束：
//   1. delegation 组里的 tool-subagent 必须保留 —— 它是主 agent 下发子 agent 的唯一途径。
//   2. 画布成环直接抛错，不生成一个永远等不到上游的死循环人格。
//   3. persona 用 YAML 字面块标量（|-）输出，所有内容统一缩进，不依赖折行规则；
//      任务/标准里的换行会先压成空格，避免把块标量撑破。

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 中文名 → slug
// ---------------------------------------------------------------------------
// GB2312 一级常用字（3755 个）的无声调拼音表，形如「剧ju 本ben 工gong 坊fang」。
// 由 macOS Foundation 的 CFStringTransform 离线生成，运行时零依赖、不联网。
// 表外的汉字当作分隔符跳过；整名一个可用字符都没有时走 fallback。
const PINYIN_TABLE = (
  '啊a 阿a 埃ai 挨ai 哎ai 唉ai 哀ai 皑ai 癌ai 蔼ai 矮ai 艾ai 碍ai 爱ai 隘ai 鞍an 氨an 安an 俺an 按an 暗an 岸an 胺an 案an 肮ang ' +
  '昂ang 盎ang 凹ao 敖ao 熬ao 翱ao 袄ao 傲ao 奥ao 懊ao 澳ao 芭ba 捌ba 扒ba 叭ba 吧ba 笆ba 八ba 疤ba 巴ba 拔ba 跋ba 靶ba 把ba ' +
  '耙ba 坝ba 霸ba 罢ba 爸ba 白bai 柏bai 百bai 摆bai 佰bai 败bai 拜bai 稗bai 斑ban 班ban 搬ban 扳ban 般ban 颁ban 板ban 版ban ' +
  '扮ban 拌ban 伴ban 瓣ban 半ban 办ban 绊ban 邦bang 帮bang 梆bang 榜bang 膀bang 绑bang 棒bang 磅bang 蚌bang 镑bang 傍bang ' +
  '谤bang 苞bao 胞bao 包bao 褒bao 剥bo 薄bao 雹bao 保bao 堡bao 饱bao 宝bao 抱bao 报bao 暴bao 豹bao 鲍bao 爆bao 杯bei 碑bei ' +
  '悲bei 卑bei 北bei 辈bei 背bei 贝bei 钡bei 倍bei 狈bei 备bei 惫bei 焙bei 被bei 奔ben 苯ben 本ben 笨ben 崩beng 绷beng ' +
  '甭beng 泵beng 蹦beng 迸beng 逼bi 鼻bi 比bi 鄙bi 笔bi 彼bi 碧bi 蓖bi 蔽bi 毕bi 毙bi 毖bi 币bi 庇bi 痹bi 闭bi 敝bi 弊bi 必bi ' +
  '辟pi 壁bi 臂bi 避bi 陛bi 鞭bian 边bian 编bian 贬bian 扁bian 便bian 变bian 卞bian 辨bian 辩bian 辫bian 遍bian 标biao ' +
  '彪biao 膘biao 表biao 鳖bie 憋bie 别bie 瘪bie 彬bin 斌bin 濒bin 滨bin 宾bin 摈bin 兵bing 冰bing 柄bing 丙bing 秉bing ' +
  '饼bing 炳bing 病bing 并bing 玻bo 菠bo 播bo 拨bo 钵bo 波bo 博bo 勃bo 搏bo 铂bo 箔bo 伯bo 帛bo 舶bo 脖bo 膊bo 渤bo 泊po 驳bo ' +
  '捕bu 卜bo 哺bu 补bu 埠bu 不bu 布bu 步bu 簿bu 部bu 怖bu 擦ca 猜cai 裁cai 材cai 才cai 财cai 睬cai 踩cai 采cai 彩cai 菜cai ' +
  '蔡cai 餐can 参can 蚕can 残can 惭can 惨can 灿can 苍cang 舱cang 仓cang 沧cang 藏cang 操cao 糙cao 槽cao 曹cao 草cao 厕ce ' +
  '策ce 侧ce 册ce 测ce 层ceng 蹭ceng 插cha 叉cha 茬cha 茶cha 查cha 碴cha 搽cha 察cha 岔cha 差cha 诧cha 拆chai 柴chai 豺chai ' +
  '搀chan 掺chan 蝉chan 馋chan 谗chan 缠chan 铲chan 产chan 阐chan 颤chan 昌chang 猖chang 场chang 尝chang 常chang ' +
  '长zhang 偿chang 肠chang 厂chang 敞chang 畅chang 唱chang 倡chang 超chao 抄chao 钞chao 朝chao 嘲chao 潮chao 巢chao ' +
  '吵chao 炒chao 车che 扯che 撤che 掣che 彻che 澈che 郴chen 臣chen 辰chen 尘chen 晨chen 忱chen 沉chen 陈chen 趁chen ' +
  '衬chen 撑cheng 称cheng 城cheng 橙cheng 成cheng 呈cheng 乘cheng 程cheng 惩cheng 澄cheng 诚cheng 承cheng 逞cheng ' +
  '骋cheng 秤cheng 吃chi 痴chi 持chi 匙shi 池chi 迟chi 弛chi 驰chi 耻chi 齿chi 侈chi 尺chi 赤chi 翅chi 斥chi 炽chi 充chong ' +
  '冲chong 虫chong 崇chong 宠chong 抽chou 酬chou 畴chou 踌chou 稠chou 愁chou 筹chou 仇chou 绸chou 瞅chou 丑chou 臭chou ' +
  '初chu 出chu 橱chu 厨chu 躇chu 锄chu 雏chu 滁chu 除chu 楚chu 础chu 储chu 矗chu 搐chu 触chu 处chu 揣chuai 川chuan 穿chuan ' +
  '椽chuan 传chuan 船chuan 喘chuan 串chuan 疮chuang 窗chuang 幢chuang 床chuang 闯chuang 创chuang 吹chui 炊chui 捶chui ' +
  '锤chui 垂chui 春chun 椿chun 醇chun 唇chun 淳chun 纯chun 蠢chun 戳chuo 绰chuo 疵ci 茨ci 磁ci 雌ci 辞ci 慈ci 瓷ci 词ci ' +
  '此ci 刺ci 赐ci 次ci 聪cong 葱cong 囱cong 匆cong 从cong 丛cong 凑cou 粗cu 醋cu 簇cu 促cu 蹿cuan 篡cuan 窜cuan 摧cui 崔cui ' +
  '催cui 脆cui 瘁cui 粹cui 淬cui 翠cui 村cun 存cun 寸cun 磋cuo 撮cuo 搓cuo 措cuo 挫cuo 错cuo 搭da 达da 答da 瘩da 打da 大da ' +
  '呆dai 歹dai 傣dai 戴dai 带dai 殆dai 代dai 贷dai 袋dai 待dai 逮dai 怠dai 耽dan 担dan 丹dan 单dan 郸dan 掸dan 胆dan 旦dan ' +
  '氮dan 但dan 惮dan 淡dan 诞dan 弹dan 蛋dan 当dang 挡dang 党dang 荡dang 档dang 刀dao 捣dao 蹈dao 倒dao 岛dao 祷dao 导dao ' +
  '到dao 稻dao 悼dao 道dao 盗dao 德de 得de 的de 蹬deng 灯deng 登deng 等deng 瞪deng 凳deng 邓deng 堤di 低di 滴di 迪di 敌di ' +
  '笛di 狄di 涤di 翟di 嫡di 抵di 底di 地de 蒂di 第di 帝di 弟di 递di 缔di 颠dian 掂dian 滇dian 碘dian 点dian 典dian 靛dian ' +
  '垫dian 电dian 佃dian 甸dian 店dian 惦dian 奠dian 淀dian 殿dian 碉diao 叼diao 雕diao 凋diao 刁diao 掉diao 吊diao ' +
  '钓diao 调diao 跌die 爹die 碟die 蝶die 迭die 谍die 叠die 丁ding 盯ding 叮ding 钉ding 顶ding 鼎ding 锭ding 定ding 订ding ' +
  '丢diu 东dong 冬dong 董dong 懂dong 动dong 栋dong 侗dong 恫dong 冻dong 洞dong 兜dou 抖dou 斗dou 陡dou 豆dou 逗dou 痘dou ' +
  '都dou 督du 毒du 犊du 独du 读du 堵du 睹du 赌du 杜du 镀du 肚du 度du 渡du 妒du 端duan 短duan 锻duan 段duan 断duan 缎duan ' +
  '堆dui 兑dui 队dui 对dui 墩dun 吨dun 蹲dun 敦dun 顿dun 囤dun 钝dun 盾dun 遁dun 掇duo 哆duo 多duo 夺duo 垛duo 躲duo 朵duo ' +
  '跺duo 舵duo 剁duo 惰duo 堕duo 蛾e 峨e 鹅e 俄e 额e 讹e 娥e 恶e 厄e 扼e 遏e 鄂e 饿e 恩en 而er 儿er 耳er 尔er 饵er 洱er 二er 贰er ' +
  '发fa 罚fa 筏fa 伐fa 乏fa 阀fa 法fa 珐fa 藩fan 帆fan 番fan 翻fan 樊fan 矾fan 钒fan 繁fan 凡fan 烦fan 反fan 返fan 范fan ' +
  '贩fan 犯fan 饭fan 泛fan 坊fang 芳fang 方fang 肪fang 房fang 防fang 妨fang 仿fang 访fang 纺fang 放fang 菲fei 非fei 啡fei ' +
  '飞fei 肥fei 匪fei 诽fei 吠fei 肺fei 废fei 沸fei 费fei 芬fen 酚fen 吩fen 氛fen 分fen 纷fen 坟fen 焚fen 汾fen 粉fen 奋fen ' +
  '份fen 忿fen 愤fen 粪fen 丰feng 封feng 枫feng 蜂feng 峰feng 锋feng 风feng 疯feng 烽feng 逢feng 冯feng 缝feng 讽feng ' +
  '奉feng 凤feng 佛fu 否fou 夫fu 敷fu 肤fu 孵fu 扶fu 拂fu 辐fu 幅fu 氟fu 符fu 伏fu 俘fu 服fu 浮fu 涪fu 福fu 袱fu 弗fu 甫fu 抚fu ' +
  '辅fu 俯fu 釜fu 斧fu 脯pu 腑fu 府fu 腐fu 赴fu 副fu 覆fu 赋fu 复fu 傅fu 付fu 阜fu 父fu 腹fu 负fu 富fu 讣fu 附fu 妇fu 缚fu 咐fu ' +
  '噶ga 嘎ga 该gai 改gai 概gai 钙gai 盖gai 溉gai 干gan 甘gan 杆gan 柑gan 竿gan 肝gan 赶gan 感gan 秆gan 敢gan 赣gan 冈gang ' +
  '刚gang 钢gang 缸gang 肛gang 纲gang 岗gang 港gang 杠gang 篙gao 皋gao 高gao 膏gao 羔gao 糕gao 搞gao 镐gao 稿gao 告gao ' +
  '哥ge 歌ge 搁ge 戈ge 鸽ge 胳ge 疙ge 割ge 革ge 葛ge 格ge 蛤ha 阁ge 隔ge 铬ge 个ge 各ge 给gei 根gen 跟gen 耕geng 更geng 庚geng ' +
  '羹geng 埂geng 耿geng 梗geng 工gong 攻gong 功gong 恭gong 龚gong 供gong 躬gong 公gong 宫gong 弓gong 巩gong 汞gong ' +
  '拱gong 贡gong 共gong 钩gou 勾gou 沟gou 苟gou 狗gou 垢gou 构gou 购gou 够gou 辜gu 菇gu 咕gu 箍gu 估gu 沽gu 孤gu 姑gu 鼓gu ' +
  '古gu 蛊gu 骨gu 谷gu 股gu 故gu 顾gu 固gu 雇gu 刮gua 瓜gua 剐gua 寡gua 挂gua 褂gua 乖guai 拐guai 怪guai 棺guan 关guan ' +
  '官guan 冠guan 观guan 管guan 馆guan 罐guan 惯guan 灌guan 贯guan 光guang 广guang 逛guang 瑰gui 规gui 圭gui 硅gui 归gui ' +
  '龟gui 闺gui 轨gui 鬼gui 诡gui 癸gui 桂gui 柜gui 跪gui 贵gui 刽gui 辊gun 滚gun 棍gun 锅guo 郭guo 国guo 果guo 裹guo 过guo ' +
  '哈ha 骸hai 孩hai 海hai 氦hai 亥hai 害hai 骇hai 酣han 憨han 邯han 韩han 含han 涵han 寒han 函han 喊han 罕han 翰han 撼han ' +
  '捍han 旱han 憾han 悍han 焊han 汗han 汉han 夯hang 杭hang 航hang 壕hao 嚎hao 豪hao 毫hao 郝hao 好hao 耗hao 号hao 浩hao ' +
  '呵he 喝he 荷he 菏he 核he 禾he 和he 何he 合he 盒he 貉hao 阂he 河he 涸he 赫he 褐he 鹤he 贺he 嘿hei 黑hei 痕hen 很hen 狠hen ' +
  '恨hen 哼heng 亨heng 横heng 衡heng 恒heng 轰hong 哄hong 烘hong 虹hong 鸿hong 洪hong 宏hong 弘hong 红hong 喉hou 侯hou ' +
  '猴hou 吼hou 厚hou 候hou 后hou 呼hu 乎hu 忽hu 瑚hu 壶hu 葫hu 胡hu 蝴hu 狐hu 糊hu 湖hu 弧hu 虎hu 唬hu 护hu 互hu 沪hu 户hu ' +
  '花hua 哗hua 华hua 猾hua 滑hua 画hua 划hua 化hua 话hua 槐huai 徊huai 怀huai 淮huai 坏huai 欢huan 环huan 桓huan 还hai ' +
  '缓huan 换huan 患huan 唤huan 痪huan 豢huan 焕huan 涣huan 宦huan 幻huan 荒huang 慌huang 黄huang 磺huang 蝗huang ' +
  '簧huang 皇huang 凰huang 惶huang 煌huang 晃huang 幌huang 恍huang 谎huang 灰hui 挥hui 辉hui 徽hui 恢hui 蛔hui 回hui ' +
  '毁hui 悔hui 慧hui 卉hui 惠hui 晦hui 贿hui 秽hui 会hui 烩hui 汇hui 讳hui 诲hui 绘hui 荤hun 昏hun 婚hun 魂hun 浑hun 混hun ' +
  '豁huo 活huo 伙huo 火huo 获huo 或huo 惑huo 霍huo 货huo 祸huo 击ji 圾ji 基ji 机ji 畸ji 稽ji 积ji 箕ji 肌ji 饥ji 迹ji 激ji ' +
  '讥ji 鸡ji 姬ji 绩ji 缉ji 吉ji 极ji 棘ji 辑ji 籍ji 集ji 及ji 急ji 疾ji 汲ji 即ji 嫉ji 级ji 挤ji 几ji 脊ji 己ji 蓟ji 技ji 冀ji ' +
  '季ji 伎ji 祭ji 剂ji 悸ji 济ji 寄ji 寂ji 计ji 记ji 既ji 忌ji 际ji 妓ji 继ji 纪ji 嘉jia 枷jia 夹jia 佳jia 家jia 加jia 荚jia ' +
  '颊jia 贾jia 甲jia 钾jia 假jia 稼jia 价jia 架jia 驾jia 嫁jia 歼jian 监jian 坚jian 尖jian 笺jian 间jian 煎jian 兼jian ' +
  '肩jian 艰jian 奸jian 缄jian 茧jian 检jian 柬jian 碱jian 硷jian 拣jian 捡jian 简jian 俭jian 剪jian 减jian 荐jian 槛kan ' +
  '鉴jian 践jian 贱jian 见jian 键jian 箭jian 件jian 健jian 舰jian 剑jian 饯jian 渐jian 溅jian 涧jian 建jian 僵jiang ' +
  '姜jiang 将jiang 浆jiang 江jiang 疆jiang 蒋jiang 桨jiang 奖jiang 讲jiang 匠jiang 酱jiang 降jiang 蕉jiao 椒jiao ' +
  '礁jiao 焦jiao 胶jiao 交jiao 郊jiao 浇jiao 骄jiao 娇jiao 嚼jue 搅jiao 铰jiao 矫jiao 侥jiao 脚jiao 狡jiao 角jiao 饺jiao ' +
  '缴jiao 绞jiao 剿jiao 教jiao 酵jiao 轿jiao 较jiao 叫jiao 窖jiao 揭jie 接jie 皆jie 秸jie 街jie 阶jie 截jie 劫jie 节jie ' +
  '桔jie 杰jie 捷jie 睫jie 竭jie 洁jie 结jie 解jie 姐jie 戒jie 藉ji 芥jie 界jie 借jie 介jie 疥jie 诫jie 届jie 巾jin 筋jin ' +
  '斤jin 金jin 今jin 津jin 襟jin 紧jin 锦jin 仅jin 谨jin 进jin 靳jin 晋jin 禁jin 近jin 烬jin 浸jin 尽jin 劲jin 荆jing ' +
  '兢jing 茎jing 睛jing 晶jing 鲸jing 京jing 惊jing 精jing 粳jing 经jing 井jing 警jing 景jing 颈jing 静jing 境jing ' +
  '敬jing 镜jing 径jing 痉jing 靖jing 竟jing 竞jing 净jing 炯jiong 窘jiong 揪jiu 究jiu 纠jiu 玖jiu 韭jiu 久jiu 灸jiu ' +
  '九jiu 酒jiu 厩jiu 救jiu 旧jiu 臼jiu 舅jiu 咎jiu 就jiu 疚jiu 鞠ju 拘ju 狙ju 疽ju 居ju 驹ju 菊ju 局ju 咀ju 矩ju 举ju 沮ju ' +
  '聚ju 拒ju 据ju 巨ju 具ju 距ju 踞ju 锯ju 俱ju 句ju 惧ju 炬ju 剧ju 捐juan 鹃juan 娟juan 倦juan 眷juan 卷juan 绢juan 撅jue ' +
  '攫jue 抉jue 掘jue 倔jue 爵jue 觉jue 决jue 诀jue 绝jue 均jun 菌jun 钧jun 军jun 君jun 峻jun 俊jun 竣jun 浚jun 郡jun 骏jun ' +
  '喀ka 咖ka 卡ka 咯ge 开kai 揩kai 楷kai 凯kai 慨kai 刊kan 堪kan 勘kan 坎kan 砍kan 看kan 康kang 慷kang 糠kang 扛kang 抗kang ' +
  '亢kang 炕kang 考kao 拷kao 烤kao 靠kao 坷ke 苛ke 柯ke 棵ke 磕ke 颗ke 科ke 壳ke 咳hai 可ke 渴ke 克ke 刻ke 客ke 课ke 肯ken ' +
  '啃ken 垦ken 恳ken 坑keng 吭keng 空kong 恐kong 孔kong 控kong 抠kou 口kou 扣kou 寇kou 枯ku 哭ku 窟ku 苦ku 酷ku 库ku 裤ku ' +
  '夸kua 垮kua 挎kua 跨kua 胯kua 块kuai 筷kuai 侩kuai 快kuai 宽kuan 款kuan 匡kuang 筐kuang 狂kuang 框kuang 矿kuang ' +
  '眶kuang 旷kuang 况kuang 亏kui 盔kui 岿kui 窥kui 葵kui 奎kui 魁kui 傀kui 馈kui 愧kui 溃kui 坤kun 昆kun 捆kun 困kun 括kuo ' +
  '扩kuo 廓kuo 阔kuo 垃la 拉la 喇la 蜡la 腊la 辣la 啦la 莱lai 来lai 赖lai 蓝lan 婪lan 栏lan 拦lan 篮lan 阑lan 兰lan 澜lan ' +
  '谰lan 揽lan 览lan 懒lan 缆lan 烂lan 滥lan 琅lang 榔lang 狼lang 廊lang 郎lang 朗lang 浪lang 捞lao 劳lao 牢lao 老lao ' +
  '佬lao 姥lao 酪lao 烙lao 涝lao 勒lei 乐le 雷lei 镭lei 蕾lei 磊lei 累lei 儡lei 垒lei 擂lei 肋lei 类lei 泪lei 棱leng 楞leng ' +
  '冷leng 厘li 梨li 犁li 黎li 篱li 狸li 离li 漓li 理li 李li 里li 鲤li 礼li 莉li 荔li 吏li 栗li 丽li 厉li 励li 砾li 历li 利li ' +
  '傈li 例li 俐li 痢li 立li 粒li 沥li 隶li 力li 璃li 哩li 俩lia 联lian 莲lian 连lian 镰lian 廉lian 怜lian 涟lian 帘lian ' +
  '敛lian 脸lian 链lian 恋lian 炼lian 练lian 粮liang 凉liang 梁liang 粱liang 良liang 两liang 辆liang 量liang 晾liang ' +
  '亮liang 谅liang 撩liao 聊liao 僚liao 疗liao 燎liao 寥liao 辽liao 潦liao 了le 撂liao 镣liao 廖liao 料liao 列lie 裂lie ' +
  '烈lie 劣lie 猎lie 琳lin 林lin 磷lin 霖lin 临lin 邻lin 鳞lin 淋lin 凛lin 赁lin 吝lin 拎lin 玲ling 菱ling 零ling 龄ling ' +
  '铃ling 伶ling 羚ling 凌ling 灵ling 陵ling 岭ling 领ling 另ling 令ling 溜liu 琉liu 榴liu 硫liu 馏liu 留liu 刘liu 瘤liu ' +
  '流liu 柳liu 六liu 龙long 聋long 咙long 笼long 窿long 隆long 垄long 拢long 陇long 楼lou 娄lou 搂lou 篓lou 漏lou 陋lou ' +
  '芦lu 卢lu 颅lu 庐lu 炉lu 掳lu 卤lu 虏lu 鲁lu 麓lu 碌lu 露lu 路lu 赂lu 鹿lu 潞lu 禄lu 录lu 陆lu 戮lu 驴lu 吕lu 铝lu 侣lu 旅lu ' +
  '履lu 屡lu 缕lu 虑lu 氯lu 律lu 率lu 滤lu 绿lu 峦luan 挛luan 孪luan 滦luan 卵luan 乱luan 掠lue 略lue 抡lun 轮lun 伦lun ' +
  '仑lun 沦lun 纶lun 论lun 萝luo 螺luo 罗luo 逻luo 锣luo 箩luo 骡luo 裸luo 落luo 洛luo 骆luo 络luo 妈ma 麻ma 玛ma 码ma 蚂ma ' +
  '马ma 骂ma 嘛ma 吗ma 埋mai 买mai 麦mai 卖mai 迈mai 脉mai 瞒man 馒man 蛮man 满man 蔓man 曼man 慢man 漫man 谩man 芒mang ' +
  '茫mang 盲mang 氓mang 忙mang 莽mang 猫mao 茅mao 锚mao 毛mao 矛mao 铆mao 卯mao 茂mao 冒mao 帽mao 貌mao 贸mao 么me 玫mei ' +
  '枚mei 梅mei 酶mei 霉mei 煤mei 没mei 眉mei 媒mei 镁mei 每mei 美mei 昧mei 寐mei 妹mei 媚mei 门men 闷men 们men 萌meng ' +
  '蒙meng 檬meng 盟meng 锰meng 猛meng 梦meng 孟meng 眯mi 醚mi 靡mi 糜mi 迷mi 谜mi 弥mi 米mi 秘mi 觅mi 泌mi 蜜mi 密mi 幂mi ' +
  '棉mian 眠mian 绵mian 冕mian 免mian 勉mian 娩mian 缅mian 面mian 苗miao 描miao 瞄miao 藐miao 秒miao 渺miao 庙miao ' +
  '妙miao 蔑mie 灭mie 民min 抿min 皿min 敏min 悯min 闽min 明ming 螟ming 鸣ming 铭ming 名ming 命ming 谬miu 摸mo 摹mo 蘑mo ' +
  '模mo 膜mo 磨mo 摩mo 魔mo 抹mo 末mo 莫mo 墨mo 默mo 沫mo 漠mo 寞mo 陌mo 谋mou 牟mou 某mou 拇mu 牡mu 亩mu 姆mu 母mu 墓mu 暮mu ' +
  '幕mu 募mu 慕mu 木mu 目mu 睦mu 牧mu 穆mu 拿na 哪na 呐na 钠na 那na 娜na 纳na 氖nai 乃nai 奶nai 耐nai 奈nai 南nan 男nan 难nan ' +
  '囊nang 挠nao 脑nao 恼nao 闹nao 淖nao 呢ne 馁nei 内nei 嫩nen 能neng 妮ni 霓ni 倪ni 泥ni 尼ni 拟ni 你ni 匿ni 腻ni 逆ni 溺ni ' +
  '蔫nian 拈nian 年nian 碾nian 撵nian 捻nian 念nian 娘niang 酿niang 鸟niao 尿niao 捏nie 聂nie 孽nie 啮nie 镊nie 镍nie ' +
  '涅nie 您nin 柠ning 狞ning 凝ning 宁ning 拧ning 泞ning 牛niu 扭niu 钮niu 纽niu 脓nong 浓nong 农nong 弄nong 奴nu 努nu ' +
  '怒nu 女nu 暖nuan 虐nue 疟nue 挪nuo 懦nuo 糯nuo 诺nuo 哦o 欧ou 鸥ou 殴ou 藕ou 呕ou 偶ou 沤ou 啪pa 趴pa 爬pa 帕pa 怕pa 琶pa ' +
  '拍pai 排pai 牌pai 徘pai 湃pai 派pai 攀pan 潘pan 盘pan 磐pan 盼pan 畔pan 判pan 叛pan 乓pang 庞pang 旁pang 耪pang 胖pang ' +
  '抛pao 咆pao 刨pao 炮pao 袍pao 跑pao 泡pao 呸pei 胚pei 培pei 裴pei 赔pei 陪pei 配pei 佩pei 沛pei 喷pen 盆pen 砰peng ' +
  '抨peng 烹peng 澎peng 彭peng 蓬peng 棚peng 硼peng 篷peng 膨peng 朋peng 鹏peng 捧peng 碰peng 坯pi 砒pi 霹pi 批pi 披pi ' +
  '劈pi 琵pi 毗pi 啤pi 脾pi 疲pi 皮pi 匹pi 痞pi 僻pi 屁pi 譬pi 篇pian 偏pian 片pian 骗pian 飘piao 漂piao 瓢piao 票piao 撇pie ' +
  '瞥pie 拼pin 频pin 贫pin 品pin 聘pin 乒ping 坪ping 苹ping 萍ping 平ping 凭ping 瓶ping 评ping 屏ping 坡po 泼po 颇po 婆po ' +
  '破po 魄po 迫po 粕po 剖pou 扑pu 铺pu 仆pu 莆pu 葡pu 菩pu 蒲pu 埔bu 朴pu 圃pu 普pu 浦pu 谱pu 曝pu 瀑pu 期qi 欺qi 栖qi 戚qi 妻qi ' +
  '七qi 凄qi 漆qi 柒qi 沏qi 其qi 棋qi 奇qi 歧qi 畦qi 崎qi 脐qi 齐qi 旗qi 祈qi 祁qi 骑qi 起qi 岂qi 乞qi 企qi 启qi 契qi 砌qi 器qi ' +
  '气qi 迄qi 弃qi 汽qi 泣qi 讫qi 掐qia 恰qia 洽qia 牵qian 扦qian 钎qian 铅qian 千qian 迁qian 签qian 仟qian 谦qian 乾qian ' +
  '黔qian 钱qian 钳qian 前qian 潜qian 遣qian 浅qian 谴qian 堑qian 嵌qian 欠qian 歉qian 枪qiang 呛qiang 腔qiang 羌qiang ' +
  '墙qiang 蔷qiang 强qiang 抢qiang 橇qiao 锹qiao 敲qiao 悄qiao 桥qiao 瞧qiao 乔qiao 侨qiao 巧qiao 鞘qiao 撬qiao 翘qiao ' +
  '峭qiao 俏qiao 窍qiao 切qie 茄jia 且qie 怯qie 窃qie 钦qin 侵qin 亲qin 秦qin 琴qin 勤qin 芹qin 擒qin 禽qin 寝qin 沁qin ' +
  '青qing 轻qing 氢qing 倾qing 卿qing 清qing 擎qing 晴qing 氰qing 情qing 顷qing 请qing 庆qing 琼qiong 穷qiong 秋qiu ' +
  '丘qiu 邱qiu 球qiu 求qiu 囚qiu 酋qiu 泅qiu 趋qu 区qu 蛆qu 曲qu 躯qu 屈qu 驱qu 渠qu 取qu 娶qu 龋qu 趣qu 去qu 圈quan 颧quan ' +
  '权quan 醛quan 泉quan 全quan 痊quan 拳quan 犬quan 券quan 劝quan 缺que 炔que 瘸que 却que 鹊que 榷que 确que 雀que 裙qun ' +
  '群qun 然ran 燃ran 冉ran 染ran 瓤rang 壤rang 攘rang 嚷rang 让rang 饶rao 扰rao 绕rao 惹re 热re 壬ren 仁ren 人ren 忍ren ' +
  '韧ren 任ren 认ren 刃ren 妊ren 纫ren 扔reng 仍reng 日ri 戎rong 茸rong 蓉rong 荣rong 融rong 熔rong 溶rong 容rong 绒rong ' +
  '冗rong 揉rou 柔rou 肉rou 茹ru 蠕ru 儒ru 孺ru 如ru 辱ru 乳ru 汝ru 入ru 褥ru 软ruan 阮ruan 蕊rui 瑞rui 锐rui 闰run 润run ' +
  '若ruo 弱ruo 撒sa 洒sa 萨sa 腮sai 鳃sai 塞sai 赛sai 三san 叁san 伞san 散san 桑sang 嗓sang 丧sang 搔sao 骚sao 扫sao 嫂sao ' +
  '瑟se 色se 涩se 森sen 僧seng 莎sha 砂sha 杀sha 刹sha 沙sha 纱sha 傻sha 啥sha 煞sha 筛shai 晒shai 珊shan 苫shan 杉shan ' +
  '山shan 删shan 煽shan 衫shan 闪shan 陕shan 擅shan 赡shan 膳shan 善shan 汕shan 扇shan 缮shan 墒shang 伤shang 商shang ' +
  '赏shang 晌shang 上shang 尚shang 裳shang 梢shao 捎shao 稍shao 烧shao 芍shao 勺shao 韶shao 少shao 哨shao 邵shao 绍shao ' +
  '奢she 赊she 蛇she 舌she 舍she 赦she 摄she 射she 慑she 涉she 社she 设she 砷shen 申shen 呻shen 伸shen 身shen 深shen ' +
  '娠shen 绅shen 神shen 沈shen 审shen 婶shen 甚shen 肾shen 慎shen 渗shen 声sheng 生sheng 甥sheng 牲sheng 升sheng ' +
  '绳sheng 省sheng 盛sheng 剩sheng 胜sheng 圣sheng 师shi 失shi 狮shi 施shi 湿shi 诗shi 尸shi 虱shi 十shi 石shi 拾shi ' +
  '时shi 什shen 食shi 蚀shi 实shi 识shi 史shi 矢shi 使shi 屎shi 驶shi 始shi 式shi 示shi 士shi 世shi 柿shi 事shi 拭shi 誓shi ' +
  '逝shi 势shi 是shi 嗜shi 噬shi 适shi 仕shi 侍shi 释shi 饰shi 氏shi 市shi 恃shi 室shi 视shi 试shi 收shou 手shou 首shou ' +
  '守shou 寿shou 授shou 售shou 受shou 瘦shou 兽shou 蔬shu 枢shu 梳shu 殊shu 抒shu 输shu 叔shu 舒shu 淑shu 疏shu 书shu ' +
  '赎shu 孰shu 熟shu 薯shu 暑shu 曙shu 署shu 蜀shu 黍shu 鼠shu 属shu 术shu 述shu 树shu 束shu 戍shu 竖shu 墅shu 庶shu 数shu ' +
  '漱shu 恕shu 刷shua 耍shua 摔shuai 衰shuai 甩shuai 帅shuai 栓shuan 拴shuan 霜shuang 双shuang 爽shuang 谁shei 水shui ' +
  '睡shui 税shui 吮shun 瞬shun 顺shun 舜shun 说shuo 硕shuo 朔shuo 烁shuo 斯si 撕si 嘶si 思si 私si 司si 丝si 死si 肆si 寺si ' +
  '嗣si 四si 伺ci 似si 饲si 巳si 松song 耸song 怂song 颂song 送song 宋song 讼song 诵song 搜sou 艘sou 擞sou 嗽sou 苏su 酥su ' +
  '俗su 素su 速su 粟su 僳su 塑su 溯su 宿su 诉su 肃su 酸suan 蒜suan 算suan 虽sui 隋sui 随sui 绥sui 髓sui 碎sui 岁sui 穗sui ' +
  '遂sui 隧sui 祟sui 孙sun 损sun 笋sun 蓑suo 梭suo 唆suo 缩suo 琐suo 索suo 锁suo 所suo 塌ta 他ta 它ta 她ta 塔ta 獭ta 挞ta ' +
  '蹋ta 踏ta 胎tai 苔tai 抬tai 台tai 泰tai 酞tai 太tai 态tai 汰tai 坍tan 摊tan 贪tan 瘫tan 滩tan 坛tan 檀tan 痰tan 潭tan ' +
  '谭tan 谈tan 坦tan 毯tan 袒tan 碳tan 探tan 叹tan 炭tan 汤tang 塘tang 搪tang 堂tang 棠tang 膛tang 唐tang 糖tang 倘tang ' +
  '躺tang 淌tang 趟tang 烫tang 掏tao 涛tao 滔tao 绦tao 萄tao 桃tao 逃tao 淘tao 陶tao 讨tao 套tao 特te 藤teng 腾teng 疼teng ' +
  '誊teng 梯ti 剔ti 踢ti 锑ti 提ti 题ti 蹄ti 啼ti 体ti 替ti 嚏ti 惕ti 涕ti 剃ti 屉ti 天tian 添tian 填tian 田tian 甜tian ' +
  '恬tian 舔tian 腆tian 挑tiao 条tiao 迢tiao 眺tiao 跳tiao 贴tie 铁tie 帖tie 厅ting 听ting 烃ting 汀ting 廷ting 停ting ' +
  '亭ting 庭ting 挺ting 艇ting 通tong 桐tong 酮tong 瞳tong 同tong 铜tong 彤tong 童tong 桶tong 捅tong 筒tong 统tong ' +
  '痛tong 偷tou 投tou 头tou 透tou 凸tu 秃tu 突tu 图tu 徒tu 途tu 涂tu 屠tu 土tu 吐tu 兔tu 湍tuan 团tuan 推tui 颓tui 腿tui ' +
  '蜕tui 褪tui 退tui 吞tun 屯tun 臀tun 拖tuo 托tuo 脱tuo 鸵tuo 陀tuo 驮tuo 驼tuo 椭tuo 妥tuo 拓ta 唾tuo 挖wa 哇wa 蛙wa 洼wa ' +
  '娃wa 瓦wa 袜wa 歪wai 外wai 豌wan 弯wan 湾wan 玩wan 顽wan 丸wan 烷wan 完wan 碗wan 挽wan 晚wan 皖wan 惋wan 宛wan 婉wan ' +
  '万wan 腕wan 汪wang 王wang 亡wang 枉wang 网wang 往wang 旺wang 望wang 忘wang 妄wang 威wei 巍wei 微wei 危wei 韦wei 违wei ' +
  '桅wei 围wei 唯wei 惟wei 为wei 潍wei 维wei 苇wei 萎wei 委wei 伟wei 伪wei 尾wei 纬wei 未wei 蔚wei 味wei 畏wei 胃wei 喂wei ' +
  '魏wei 位wei 渭wei 谓wei 尉wei 慰wei 卫wei 瘟wen 温wen 蚊wen 文wen 闻wen 纹wen 吻wen 稳wen 紊wen 问wen 嗡weng 翁weng ' +
  '瓮weng 挝wo 蜗wo 涡wo 窝wo 我wo 斡wo 卧wo 握wo 沃wo 巫wu 呜wu 钨wu 乌wu 污wu 诬wu 屋wu 无wu 芜wu 梧wu 吾wu 吴wu 毋wu 武wu ' +
  '五wu 捂wu 午wu 舞wu 伍wu 侮wu 坞wu 戊wu 雾wu 晤wu 物wu 勿wu 务wu 悟wu 误wu 昔xi 熙xi 析xi 西xi 硒xi 矽xi 晰xi 嘻xi 吸xi 锡xi ' +
  '牺xi 稀xi 息xi 希xi 悉xi 膝xi 夕xi 惜xi 熄xi 烯xi 溪xi 汐xi 犀xi 檄xi 袭xi 席xi 习xi 媳xi 喜xi 铣xi 洗xi 系xi 隙xi 戏xi 细xi ' +
  '瞎xia 虾xia 匣xia 霞xia 辖xia 暇xia 峡xia 侠xia 狭xia 下xia 厦sha 夏xia 吓xia 掀xian 锨xian 先xian 仙xian 鲜xian 纤xian ' +
  '咸xian 贤xian 衔xian 舷xian 闲xian 涎xian 弦xian 嫌xian 显xian 险xian 现xian 献xian 县xian 腺xian 馅xian 羡xian ' +
  '宪xian 陷xian 限xian 线xian 相xiang 厢xiang 镶xiang 香xiang 箱xiang 襄xiang 湘xiang 乡xiang 翔xiang 祥xiang 详xiang ' +
  '想xiang 响xiang 享xiang 项xiang 巷xiang 橡xiang 像xiang 向xiang 象xiang 萧xiao 硝xiao 霄xiao 削xue 哮xiao 嚣xiao ' +
  '销xiao 消xiao 宵xiao 淆xiao 晓xiao 小xiao 孝xiao 校xiao 肖xiao 啸xiao 笑xiao 效xiao 楔xie 些xie 歇xie 蝎xie 鞋xie ' +
  '协xie 挟xie 携xie 邪xie 斜xie 胁xie 谐xie 写xie 械xie 卸xie 蟹xie 懈xie 泄xie 泻xie 谢xie 屑xie 薪xin 芯xin 锌xin 欣xin ' +
  '辛xin 新xin 忻xin 心xin 信xin 衅xin 星xing 腥xing 猩xing 惺xing 兴xing 刑xing 型xing 形xing 邢xing 行xing 醒xing ' +
  '幸xing 杏xing 性xing 姓xing 兄xiong 凶xiong 胸xiong 匈xiong 汹xiong 雄xiong 熊xiong 休xiu 修xiu 羞xiu 朽xiu 嗅xiu ' +
  '锈xiu 秀xiu 袖xiu 绣xiu 墟xu 戌xu 需xu 虚xu 嘘xu 须xu 徐xu 许xu 蓄xu 酗xu 叙xu 旭xu 序xu 畜chu 恤xu 絮xu 婿xu 绪xu 续xu ' +
  '轩xuan 喧xuan 宣xuan 悬xuan 旋xuan 玄xuan 选xuan 癣xuan 眩xuan 绚xuan 靴xue 薛xue 学xue 穴xue 雪xue 血xue 勋xun 熏xun ' +
  '循xun 旬xun 询xun 寻xun 驯xun 巡xun 殉xun 汛xun 训xun 讯xun 逊xun 迅xun 压ya 押ya 鸦ya 鸭ya 呀ya 丫ya 芽ya 牙ya 蚜ya 崖ya ' +
  '衙ya 涯ya 雅ya 哑ya 亚ya 讶ya 焉yan 咽yan 阉yan 烟yan 淹yan 盐yan 严yan 研yan 蜒yan 岩yan 延yan 言yan 颜yan 阎yan 炎yan ' +
  '沿yan 奄yan 掩yan 眼yan 衍yan 演yan 艳yan 堰yan 燕yan 厌yan 砚yan 雁yan 唁yan 彦yan 焰yan 宴yan 谚yan 验yan 殃yang ' +
  '央yang 鸯yang 秧yang 杨yang 扬yang 佯yang 疡yang 羊yang 洋yang 阳yang 氧yang 仰yang 痒yang 养yang 样yang 漾yang 邀yao ' +
  '腰yao 妖yao 瑶yao 摇yao 尧yao 遥yao 窑yao 谣yao 姚yao 咬yao 舀yao 药yao 要yao 耀yao 椰ye 噎ye 耶ye 爷ye 野ye 冶ye 也ye ' +
  '页ye 掖ye 业ye 叶ye 曳ye 腋ye 夜ye 液ye 一yi 壹yi 医yi 揖yi 铱yi 依yi 伊yi 衣yi 颐yi 夷yi 遗yi 移yi 仪yi 胰yi 疑yi 沂yi 宜yi ' +
  '姨yi 彝yi 椅yi 蚁yi 倚yi 已yi 乙yi 矣yi 以yi 艺yi 抑yi 易yi 邑yi 屹yi 亿yi 役yi 臆yi 逸yi 肄yi 疫yi 亦yi 裔yi 意yi 毅yi 忆yi ' +
  '义yi 益yi 溢yi 诣yi 议yi 谊yi 译yi 异yi 翼yi 翌yi 绎yi 茵yin 荫yin 因yin 殷yin 音yin 阴yin 姻yin 吟yin 银yin 淫yin 寅yin ' +
  '饮yin 尹yin 引yin 隐yin 印yin 英ying 樱ying 婴ying 鹰ying 应ying 缨ying 莹ying 萤ying 营ying 荧ying 蝇ying 迎ying ' +
  '赢ying 盈ying 影ying 颖ying 硬ying 映ying 哟yo 拥yong 佣yong 臃yong 痈yong 庸yong 雍yong 踊yong 蛹yong 咏yong 泳yong ' +
  '涌yong 永yong 恿yong 勇yong 用yong 幽you 优you 悠you 忧you 尤you 由you 邮you 铀you 犹you 油you 游you 酉you 有you 友you ' +
  '右you 佑you 釉you 诱you 又you 幼you 迂yu 淤yu 于yu 盂yu 榆yu 虞yu 愚yu 舆yu 余yu 俞yu 逾yu 鱼yu 愉yu 渝yu 渔yu 隅yu 予yu ' +
  '娱yu 雨yu 与yu 屿yu 禹yu 宇yu 语yu 羽yu 玉yu 域yu 芋yu 郁yu 吁xu 遇yu 喻yu 峪yu 御yu 愈yu 欲yu 狱yu 育yu 誉yu 浴yu 寓yu 裕yu ' +
  '预yu 豫yu 驭yu 鸳yuan 渊yuan 冤yuan 元yuan 垣yuan 袁yuan 原yuan 援yuan 辕yuan 园yuan 员yuan 圆yuan 猿yuan 源yuan ' +
  '缘yuan 远yuan 苑yuan 愿yuan 怨yuan 院yuan 曰yue 约yue 越yue 跃yue 钥yao 岳yue 粤yue 月yue 悦yue 阅yue 耘yun 云yun 郧yun ' +
  '匀yun 陨yun 允yun 运yun 蕴yun 酝yun 晕yun 韵yun 孕yun 匝za 砸za 杂za 栽zai 哉zai 灾zai 宰zai 载zai 再zai 在zai 咱zan ' +
  '攒zan 暂zan 赞zan 赃zang 脏zang 葬zang 遭zao 糟zao 凿zao 藻zao 枣zao 早zao 澡zao 蚤zao 躁zao 噪zao 造zao 皂zao 灶zao ' +
  '燥zao 责ze 择ze 则ze 泽ze 贼zei 怎zen 增zeng 憎zeng 曾ceng 赠zeng 扎zha 喳zha 渣zha 札zha 轧ya 铡zha 闸zha 眨zha 栅zha ' +
  '榨zha 咋za 乍zha 炸zha 诈zha 摘zhai 斋zhai 宅zhai 窄zhai 债zhai 寨zhai 瞻zhan 毡zhan 詹zhan 粘zhan 沾zhan 盏zhan ' +
  '斩zhan 辗zhan 崭zhan 展zhan 蘸zhan 栈zhan 占zhan 战zhan 站zhan 湛zhan 绽zhan 樟zhang 章zhang 彰zhang 漳zhang 张zhang ' +
  '掌zhang 涨zhang 杖zhang 丈zhang 帐zhang 账zhang 仗zhang 胀zhang 瘴zhang 障zhang 招zhao 昭zhao 找zhao 沼zhao 赵zhao ' +
  '照zhao 罩zhao 兆zhao 肇zhao 召zhao 遮zhe 折zhe 哲zhe 蛰zhe 辙zhe 者zhe 锗zhe 蔗zhe 这zhe 浙zhe 珍zhen 斟zhen 真zhen ' +
  '甄zhen 砧zhen 臻zhen 贞zhen 针zhen 侦zhen 枕zhen 疹zhen 诊zhen 震zhen 振zhen 镇zhen 阵zhen 蒸zheng 挣zheng 睁zheng ' +
  '征zheng 狰zheng 争zheng 怔zheng 整zheng 拯zheng 正zheng 政zheng 帧zhen 症zheng 郑zheng 证zheng 芝zhi 枝zhi 支zhi ' +
  '吱zhi 蜘zhi 知zhi 肢zhi 脂zhi 汁zhi 之zhi 织zhi 职zhi 直zhi 植zhi 殖zhi 执zhi 值zhi 侄zhi 址zhi 指zhi 止zhi 趾zhi 只zhi ' +
  '旨zhi 纸zhi 志zhi 挚zhi 掷zhi 至zhi 致zhi 置zhi 帜zhi 峙zhi 制zhi 智zhi 秩zhi 稚zhi 质zhi 炙zhi 痔zhi 滞zhi 治zhi 窒zhi ' +
  '中zhong 盅zhong 忠zhong 钟zhong 衷zhong 终zhong 种zhong 肿zhong 重zhong 仲zhong 众zhong 舟zhou 周zhou 州zhou 洲zhou ' +
  '诌zhou 粥zhou 轴zhou 肘zhou 帚zhou 咒zhou 皱zhou 宙zhou 昼zhou 骤zhou 珠zhu 株zhu 蛛zhu 朱zhu 猪zhu 诸zhu 诛zhu 逐zhu ' +
  '竹zhu 烛zhu 煮zhu 拄zhu 瞩zhu 嘱zhu 主zhu 著zhu 柱zhu 助zhu 蛀zhu 贮zhu 铸zhu 筑zhu 住zhu 注zhu 祝zhu 驻zhu 抓zhua ' +
  '爪zhao 拽zhuai 专zhuan 砖zhuan 转zhuan 撰zhuan 赚zhuan 篆zhuan 桩zhuang 庄zhuang 装zhuang 妆zhuang 撞zhuang ' +
  '壮zhuang 状zhuang 椎zhui 锥zhui 追zhui 赘zhui 坠zhui 缀zhui 谆zhun 准zhun 捉zhuo 拙zhuo 卓zhuo 桌zhuo 琢zuo 茁zhuo ' +
  '酌zhuo 啄zhuo 着zhe 灼zhuo 浊zhuo 兹zi 咨zi 资zi 姿zi 滋zi 淄zi 孜zi 紫zi 仔zi 籽zi 滓zi 子zi 自zi 渍zi 字zi 鬃zong 棕zong ' +
  '踪zong 宗zong 综zong 总zong 纵zong 邹zou 走zou 奏zou 揍zou 租zu 足zu 卒zu 族zu 祖zu 诅zu 阻zu 组zu 钻zuan 纂zuan 嘴zui ' +
  '醉zui 最zui 罪zui 尊zun 遵zun 昨zuo 左zuo 佐zuo 柞zha 做zuo 作zuo 坐zuo 座zuo'
);

const PINYIN_MAP = (() => {
  const map = new Map();
  for (const item of PINYIN_TABLE.trim().split(/\s+/)) {
    const ch = String.fromCodePoint(item.codePointAt(0));
    const py = item.slice(ch.length);
    if (ch && py) map.set(ch, py);
  }
  return map;
})();

/** 只留 ASCII 小写字母/数字，其余折成连字符 */
function normalizeSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 中文按词切分用 Intl.Segmenter（ICU 词典）；它会把「工坊」拆成「工」「坊」两个单字，
// 所以连续的单字再合回一个词。没有 Segmenter 时退化成两字一组。
const ZH_SEGMENTER = (() => {
  try {
    return new Intl.Segmenter('zh', { granularity: 'word' });
  } catch {
    return null;
  }
})();

/** 一串汉字 → 拼音（表外的字直接跳过） */
function hanPinyin(text) {
  let out = '';
  for (const ch of String(text)) out += PINYIN_MAP.get(ch) || '';
  return out;
}

/**
 * 画布名 → preset slug。
 * '剧本工坊' → 'juben-gongfang'；中文转写不出来时用 fallback。
 */
export function slugify(name, fallback = 'flow') {
  const raw = flat(name);
  const pieces = [];
  let singles = '';

  // 连续单字先攒着，遇到多字词/ASCII/分隔符再合成为一个词
  const flushSingles = () => {
    if (singles) {
      pieces.push(singles);
      singles = '';
    }
  };
  const pushAscii = (piece) => {
    flushSingles();
    if (piece) pieces.push(piece);
  };

  if (ZH_SEGMENTER && /[\u3400-\u9fff]/.test(raw)) {
    for (const seg of ZH_SEGMENTER.segment(raw)) {
      const text = seg.segment;
      if (!text.trim()) {
        flushSingles();
        continue;
      }
      if (/[\u3400-\u9fff]/.test(text)) {
        const py = hanPinyin(text);
        if (!py) {
          flushSingles();
        } else if ([...text].length >= 2) {
          flushSingles();
          pieces.push(py);
        } else {
          singles += py;
        }
      } else {
        pushAscii(normalizeSlug(text));
      }
    }
    flushSingles();
  } else {
    pushAscii(normalizeSlug(raw));
  }

  const slug = pieces.join('-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (slug) return slug;
  return normalizeSlug(fallback) || 'flow';
}

// ---------------------------------------------------------------------------
// 图结构
// ---------------------------------------------------------------------------

/** 取节点 id（统一成字符串） */
function nodeId(node) {
  return String(node?.id ?? '');
}

/** 有效边：两端都在画布上；悬空边忽略（和 engine.mjs 的 buildIndex 一致） */
function edgeIds(board) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  const valid = new Set(nodes.map(nodeId));
  const hit = new Set();
  for (const e of board?.edges || []) {
    const from = String(e?.from ?? '');
    const to = String(e?.to ?? '');
    if (!valid.has(from) || !valid.has(to)) continue;
    hit.add(from);
    hit.add(to);
  }
  return hit;
}

/**
 * 按入度分层：一层 = 所有前驱都落在前面的层的节点；同层并行。
 * 没有任何边的孤立节点不混进主流程，单独作为最后一层（彼此可并行）。
 * 成环抛错。
 */
export function topoLayers(board) {
  const rawNodes = Array.isArray(board?.nodes) ? board.nodes : [];
  const nodes = [];
  const seen = new Set();
  for (const n of rawNodes) {
    const id = nodeId(n);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push(n);
  }
  if (!nodes.length) return [];

  const ids = nodes.map(nodeId);
  const preds = new Map(ids.map((id) => [id, new Set()]));
  const succs = new Map(ids.map((id) => [id, new Set()]));
  for (const e of board?.edges || []) {
    const from = String(e?.from ?? '');
    const to = String(e?.to ?? '');
    if (!seen.has(from) || !seen.has(to)) continue;
    preds.get(to).add(from);
    succs.get(from).add(to);
  }

  const isolated = nodes.filter((n) => {
    const id = nodeId(n);
    return preds.get(id).size === 0 && succs.get(id).size === 0;
  });

  // 主流程只看参与边的节点；孤立节点单独收尾
  const remaining = new Set(ids.filter((id) => preds.get(id).size || succs.get(id).size));
  const layers = [];

  while (remaining.size) {
    const ready = [];
    for (const n of nodes) {
      const id = nodeId(n);
      if (!remaining.has(id)) continue;
      let blocked = false;
      for (const p of preds.get(id)) {
        if (remaining.has(p)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) ready.push(n);
    }
    if (!ready.length) throw new Error('画布有环，无法生成预设');
    layers.push({ nodes: ready });
    for (const n of ready) remaining.delete(nodeId(n));
  }

  if (isolated.length) layers.push({ nodes: isolated });
  return layers;
}

// ---------------------------------------------------------------------------
// persona
// ---------------------------------------------------------------------------

/** 所有要嵌进 YAML / 行内文本的字段先压成单行 */
function flat(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 数组字段（skills/tools）→ 干净的字符串数组 */
function asList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => flat(typeof item === 'string' ? item : item && (item.name || item.id)))
    .filter(Boolean);
}

function nodeLabel(node) {
  return flat(node?.label) || flat(node?.id) || '未命名节点';
}

function nodeIdSet(board) {
  return edgeIds(board);
}

const CN_COUNT = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

function cnCount(n) {
  return CN_COUNT[n] || String(n);
}

/** 第一层单节点 → 串行；后面单节点 → 等上一层；多节点 → 并行 */
function layerTitle(layer, index, connected) {
  const n = layer.nodes.length;
  const isolated = layer.nodes.every((node) => !connected.has(nodeId(node)));
  const head = `第 ${index + 1} 层`;
  if (isolated) {
    return n > 1
      ? `${head}（独立节点，${cnCount(n)}个可同时下发）`
      : `${head}（独立节点，可单独下发）`;
  }
  if (n > 1) return `${head}（并行，${cnCount(n)}个同时下发）`;
  if (index === 0) return `${head}（串行）`;
  return `${head}（等第 ${index} 层全部完成）`;
}

/** 一个节点在 persona 里的五行描述 */
function nodeLines(node) {
  const label = nodeLabel(node);
  const task = flat(node?.task);
  const lines = [`  ▸ ${label}${task ? ` —— ${task}` : ''}`];

  const criteria = flat(node?.criteria);
  lines.push(`    完成标准：${criteria || '（未填写）'}`);

  const model = flat(node?.model);
  lines.push(`    用模型：${model || '由调度者按需选择'}`);

  const skills = asList(node?.skills);
  if (skills.length) lines.push(`    参考技能：${skills.join('、')}`);

  const tools = asList(node?.tools);
  if (tools.length) lines.push(`    可用工具：${tools.slice(0, 5).join('、')}`);

  return lines;
}

// 从节点 task 里认出「要用户提供什么输入」。命中不了就用通用两问。
const INPUT_RULES = [
  [/题材|主题|剧情|故事/, '这次的题材（主题）是什么？'],
  [/篇幅|字数|多长|多少字|约\s*\d+\s*字/, '期望的篇幅大概多少？'],
  [/风格|文风|语气|基调/, '想要什么风格或基调？'],
  [/受众|读者|观众/, '面向什么受众？'],
  [/人物|角色|主角/, '主要人物有哪些已有设定？'],
  [/场景|对白|台词|镜头/, '有哪些必须包含的场景或台词？'],
  [/语言|英文|日文/, '用什么语言输出？'],
  [/素材|材料|附件|参考/, '有现成的素材或参考材料要提供吗？'],
];

function collectQuestions(board) {
  const text = (Array.isArray(board?.nodes) ? board.nodes : [])
    .map((n) => flat(n?.task))
    .join(' ');
  const out = [];
  for (const [re, question] of INPUT_RULES) {
    if (out.length >= 3) break;
    if (re.test(text) && !out.includes(question)) out.push(question);
  }
  if (!out.length) {
    out.push('这次要做成什么？');
    out.push('有没有必须满足的限定（篇幅、风格、受众等）？');
  }
  return out.slice(0, 3);
}

function summaryLine(layers) {
  const total = layers.reduce((sum, layer) => sum + layer.nodes.length, 0);
  if (!total) return '按既定步骤完成用户的需求。';
  if (total === 1) return `这个流程只有 1 个节点：「${nodeLabel(layers[0].nodes[0])}」。`;
  const flow = layers
    .map((layer) => layer.nodes.map(nodeLabel).join(' / '))
    .join(' → ');
  return `这个流程共 ${total} 个节点、${layers.length} 层：${flow}。`;
}

const DISPATCH_SECTION = [
  '【怎么下发】',
  '- 每个节点用一次 `subagent` 工具；prompt 里给全：任务 + 完成标准 + 上游产出',
  '- 同一层的多个节点同时下发，不要一个个等',
  '- 上游产出原样传给下游，不要自己改写或概括',
  '- 子 agent 如果还有自己的子任务，把它的子任务一并写进它的 prompt，让它继续嵌套',
].join('\n');

const WRAP_UP_SECTION = [
  '【收尾】',
  '全部跑完，把最终产出交给用户。中间有节点失败要说清楚是哪个、为什么，不要假装成功。',
].join('\n');

// ---------------------------------------------------------------------------
// 调度根节点
// ---------------------------------------------------------------------------

/**
 * 画布上的调度根节点（type === 'orchestrator'）。
 * 产品约定：一张画布最多一张 —— 它就是对话入口，也是 persona 来源。
 */
export function findOrchestrators(board) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  return nodes.filter((n) => n && n.type === 'orchestrator');
}

/** 新节点 id：orchestrator / orchestrator-2 …（避开已有 id） */
function uniqueNodeId(nodes, base = 'orchestrator') {
  const used = new Set(nodes.map(nodeId));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * 根节点 = 没有入边的节点（孤立节点也算根）。
 * 悬空边忽略，和 topoLayers 口径一致。
 */
function rootNodes(board) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  const valid = new Set(nodes.map(nodeId).filter(Boolean));
  const hasIncoming = new Set();
  for (const e of board?.edges || []) {
    const from = String(e?.from ?? '');
    const to = String(e?.to ?? '');
    if (!valid.has(from) || !valid.has(to)) continue;
    hasIncoming.add(to);
  }
  const seen = new Set();
  return nodes.filter((n) => {
    const id = nodeId(n);
    if (!valid.has(id) || seen.has(id) || hasIncoming.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** 自动补的调度卡放所有节点左侧、纵向居中；坐标允许为负（ReactFlow 支持） */
function orchestratorPosition(nodes) {
  const xs = nodes.map((n) => Number(n?.x)).filter(Number.isFinite);
  const ys = nodes.map((n) => Number(n?.y)).filter(Number.isFinite);
  return {
    x: xs.length ? Math.min(...xs) - 380 : 80,
    y: ys.length ? Math.round(ys.reduce((sum, y) => sum + y, 0) / ys.length) : 80,
  };
}

/**
 * 导出前确保画布有且只有一张调度根节点。纯函数，不落盘。
 * - 已有 1 张：原样返回
 * - 只有 1 个节点：单卡片场景，原样返回（persona 直接取这张卡）
 * - 多节点且没有：补一张 orchestrator，task = 默认调度模板，连向所有根节点
 * @returns {{board: object, added: object|null}}
 */
/**
 * 根节点（对话入口）的默认人格：刻意写得很短。
 * 子节点内容随时会变，所以只列一份 label + 一句用途的清单，不展开 criteria；
 * 具体执行交给后续节点的 AgentFlow 流。
 * 用户可以自己改写——只在新建调度卡时用这份默认值。
 */
export function orchestratorPersona(board) {
  const name = flat(board?.name) || '未命名画布';
  return [
    `你是「${name}」的对话入口。`,
    '',
    '你只负责和用户对话：问清需求、确认关键信息。',
    '',
    '需求明确后，严格按照后续节点的 AgentFlow 流去执行，不要自己直接产出结果。',
  ].join('\n');
}

/** 子节点用途：task 首句（task 为空时退回收到的 criteria 首句），压成单行、截 40 字。 */
function childPurpose(node) {
  const raw = flat(node?.task) ? String(node.task) : String(node?.criteria ?? '');
  const first =
    raw
      .split(/[\r\n。！？!?]/)
      .map((part) => part.trim())
      .find(Boolean) || '';
  const text = first.replace(/\s+/g, ' ').trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** persona 里的子节点清单：label + 一句用途。task 与 criteria 都为空的占位卡跳过。 */
function childDigest(board) {
  const nodes = (Array.isArray(board?.nodes) ? board.nodes : []).filter(
    (node) => node && node.type !== 'orchestrator',
  );
  const lines = [];
  for (const node of nodes) {
    if (!flat(node.task) && !flat(node.criteria)) continue;
    const purpose = childPurpose(node);
    lines.push(purpose ? `- ${nodeLabel(node)}：${purpose}` : `- ${nodeLabel(node)}`);
  }
  if (!lines.length) return '【子节点】（暂无）';
  return [`【子节点】共 ${lines.length} 个`, ...lines].join('\n');
}

/** 根节点的默认验收标准 */
export function orchestratorCriteria() {
  return '用户需求已确认清楚；后续节点按流程顺序全部执行完成，最终产出交给用户。';
}

/** 根节点不能有上游（它是流程起点、对话入口） */
export function assertRootHasNoUpstream(board) {
  const roots = findOrchestrators(board);
  if (!roots.length) return;
  const incoming = new Set((board?.edges || []).map((e) => String(e.to)));
  const bad = roots.filter((n) => incoming.has(String(n.id)));
  if (bad.length) {
    throw Object.assign(new Error('根节点（调度卡）不能有上游节点'), { status: 400 });
  }
}

export function ensureOrchestrator(board, opts = {}) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  const orchestrators = findOrchestrators(board);
  if (orchestrators.length > 1) throw new Error('一张画布只能有一个调度根节点');

  if (orchestrators.length === 1) {
    // 已有根节点：只保证技能/MCP 全选，人格与验收标准是用户的，绝不覆盖
    const root = orchestrators[0];
    const nextSkills = Array.isArray(opts.skills) ? [...opts.skills] : null;
    const nextTools = Array.isArray(opts.tools) ? [...opts.tools] : null;
    const changed =
      (nextSkills && JSON.stringify(root.skills || []) !== JSON.stringify(nextSkills)) ||
      (nextTools && JSON.stringify(root.tools || []) !== JSON.stringify(nextTools));
    if (!changed) return { board, added: null };
    const updated = {
      ...board,
      nodes: nodes.map((n) =>
        n.id === root.id
          ? {
              ...n,
              ...(nextSkills ? { skills: nextSkills } : {}),
              ...(nextTools ? { tools: nextTools } : {}),
            }
          : n,
      ),
    };
    return { board: updated, added: null, refreshed: true };
  }

  if (nodes.length <= 1) {
    return { board, added: null };
  }

  const name = flat(board?.name) || '未命名画布';
  // 只把「有内容的根」纳入调度：占位的空卡片（task/content 都空）连上去只会让
  // persona 里多出一个「（未填写）」节点，误导对话方。
  const allRoots = rootNodes(board);
  const meaningfulRoots = allRoots.filter(
    (n) => flat(n?.task).length > 0 || flat(n?.content).length > 0,
  );
  const roots = meaningfulRoots.length ? meaningfulRoots : allRoots;
  // 模型跟根节点走：调度卡不该是一张跑不起来的空模型卡
  const modelSource = roots.find((n) => flat(n?.model)) || nodes.find((n) => flat(n?.model)) || null;
  const { x, y } = orchestratorPosition(nodes);
  const node = {
    id: uniqueNodeId(nodes),
    label: `${name} · 调度`,
    type: 'orchestrator',
    provider: flat(modelSource?.provider),
    model: flat(modelSource?.model),
    reasoningEffort: String(modelSource?.reasoningEffort ?? ''),
    fallback: Array.isArray(modelSource?.fallback) ? [...modelSource.fallback] : [],
    fallbackEfforts:
      modelSource && modelSource.fallbackEfforts && typeof modelSource.fallbackEfforts === 'object'
        ? { ...modelSource.fallbackEfforts }
        : {},
    // 根节点默认人格（很短，用户可改）
    task: orchestratorPersona(board),
    criteria: orchestratorCriteria(),
    // 根节点默认把技能与 MCP 工具全选上（用户自建预设本来就是全套）
    skills: Array.isArray(opts.skills) ? [...opts.skills] : [],
    tools: Array.isArray(opts.tools) ? [...opts.tools] : [],
    verify: '',
    content: '',
    status: 'idle',
    usage: null,
    error: null,
    verdict: null,
    x,
    y,
  };
  const edges = [...(Array.isArray(board?.edges) ? board.edges : [])];
  for (const root of roots) edges.push({ from: node.id, to: nodeId(root) });
  return {
    board: { ...board, nodes: [...nodes, node], edges },
    added: node,
  };
}

/**
 * 现有默认调度模板：多节点画布自动补调度卡时拿它当 task。
 * 文案与历史版本一致，保住「对齐需求 + 流程 + 下发 + 收尾」四段。
 */
function dispatchPersonaTemplate(board) {
  const name = flat(board?.name) || '未命名画布';
  // 空卡片（task 与 criteria 都空）不进 persona 的流程描述：
  // 它们没有任何信息量，写进去只会让对话方看到「（未填写）」的节点。
  const source = board && Array.isArray(board.nodes) ? board : { nodes: [], edges: [] };
  const meaningful = source.nodes.filter(
    (n) => flat(n?.task).length > 0 || flat(n?.criteria).length > 0,
  );
  const personaBoard = meaningful.length
    ? { ...source, nodes: meaningful }
    : source;
  const layers = topoLayers(personaBoard);
  const connected = nodeIdSet(board);

  const who = [
    '【你是谁】',
    `你是「${name}」。`,
    summaryLine(layers),
  ].join('\n');

  const ask = [
    '【第一步：对齐需求】',
    '动手前必须先把需求问清楚，最多问 3 个问题、一次问完：',
    ...collectQuestions(board).map((q) => `- ${q}`),
    '信息够了就说「开始执行」，不要边问边跑。',
  ].join('\n');

  const sections = [
    '你是一个按固定流程组织子 agent 的调度者。',
    who,
    ask,
  ];

  // 只有一层时整个【流程】段都不写 —— 没有分层，就没有分层可讲
  if (layers.length > 1) {
    const layerTexts = layers.map((layer, index) => {
      const blocks = layer.nodes.map((node) => nodeLines(node).join('\n'));
      return [layerTitle(layer, index, connected), blocks.join('\n\n')].join('\n');
    });
    sections.push(['【流程】', layerTexts.join('\n\n')].join('\n'));
  }

  sections.push(DISPATCH_SECTION, WRAP_UP_SECTION);
  return sections.join('\n\n');
}

/**
 * persona 从哪来：orchestrator / single-card / auto-orchestrator。
 * 和 renderPersona 的四条取值规则保持一致；多张调度卡直接抛错。
 */
export function personaSource(board) {
  const orchestrators = findOrchestrators(board);
  if (orchestrators.length > 1) throw new Error('一张画布只能有一个调度根节点');
  if (orchestrators.length === 1) return 'orchestrator';
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  return nodes.length === 1 ? 'single-card' : 'auto-orchestrator';
}

/**
 * 生成中文人格。画布成环会抛错（由 topoLayers 抛出，仅模板路径需要分层）。
 * 取值顺序：调度根节点 task 原文 → 单卡片 task 原文 → 默认调度模板。
 * 结构是产品形态，别改成自由发挥的写法。
 */
export function renderPersona(board) {
  const orchestrators = findOrchestrators(board);
  if (orchestrators.length > 1) throw new Error('一张画布只能有一个调度根节点');

  if (orchestrators.length === 1) {
    const node = orchestrators[0];
    const task = String(node?.task ?? '');
    const criteria = String(node?.criteria ?? '').trim();
    const parts = [task];
    if (criteria) parts.push(`【完成标准】\n${criteria}`);
    // 清单每次导出按画布实时生成，不写进节点人格：用户改人格也不会丢
    parts.push(childDigest(board));
    return parts.join('\n\n');
  }

  // 单卡片画布 = 从 DSH 预设导入的人格卡，persona 必须原样保留
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  if (nodes.length === 1) return String(nodes[0]?.task ?? '');

  // 多节点无调度卡：和 ensureOrchestrator 补出来的卡保持同一套默认人格。
  // 人格本身不含流程细节（子节点内容会变），但成环仍然必须拦住。
  topoLayers(board);
  return [orchestratorPersona(board), childDigest(board)].join('\n\n');
}

// ---------------------------------------------------------------------------
// preset bundle 的落盘内容
// ---------------------------------------------------------------------------

/** YAML 单引号标量：换行已压平，单引号靠成对转义 */
function yamlString(value) {
  return `'${flat(value).replace(/'/g, "''")}'`;
}

// 除 persona 外，下面的插件清单逐行照抄 ~/www/dsh-plugin-sharp-agent/cordis.patch.yml
//（对应 DSH 0.2.1-rc.2 的 standard preset）。上游升级后要重新对照同步。
// 其中 delegation 组里的 tool-subagent 是下发子 agent 的唯一途径，必须保留。
const PLUGIN_REST = `      - id: agent-instructions
        name: '@deepseek-ai/dsh-agent-instructions'
        config:
          maxBytes: 65536
      - id: time-context
        name: '@deepseek-ai/dsh-time-context'
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: !!js process.platform === 'win32'
      - id: tool-pwsh
        name: '@deepseek-ai/dsh-tool-pwsh'
        disabled: !!js process.platform !== 'win32'
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
      - id: tool-fs-search
        name: '@deepseek-ai/dsh-tool-fs-search'
        config:
          sampleOverCapGlobResults: false
      - id: tool-jobs
        name: '@deepseek-ai/dsh-tool-jobs'
      - id: tool-schedule
        name: '@deepseek-ai/dsh-tool-schedule'
      - id: skill-filesystem
        name: '@deepseek-ai/dsh-skill-filesystem'
      - id: tool-skill
        name: '@deepseek-ai/dsh-tool-skill'
      - id: command-goal
        name: '@deepseek-ai/dsh-command-goal'
      - id: tool-goal
        name: '@deepseek-ai/dsh-tool-goal'
      - id: planning
        name: cordis:group
        group: true
        isolate:
          planMode: true
        config:
          - id: plan-mode
            name: '@deepseek-ai/dsh-plan-mode'
            config:
              section: |
                You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

                Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

                The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

                Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

                Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

                When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
      - id: delegation
        name: cordis:group
        group: true
        isolate:
          workflowEngine: true
        config:
          - id: tool-subagent-control
            name: '@deepseek-ai/dsh-tool-subagent-control'
          - id: tool-subagent-list-agents
            name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
          - id: tool-subagent
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: spawn
              toolName: subagent
              modelSelectionSettings: true
          - id: tool-subagent-fork
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: fork
              toolName: subagent_fork
          - id: workflow-ptc
            name: '@deepseek-ai/dsh-workflow-ptc'
            config:
              provider: spawn
          - id: tool-workflow
            name: '@deepseek-ai/dsh-tool-workflow'
      - id: tool-ask-user
        name: '@deepseek-ai/dsh-tool-ask-user'
      - id: tool-todo
        name: '@deepseek-ai/dsh-tool-todo'
        config:
          allowParallelInProgress: true
      - id: tool-web
        name: '@deepseek-ai/dsh-tool-web'
        config:
          fetch: false
          searchTimeoutMs: 60000
      - id: present
        name: '@deepseek-ai/dsh-tool-present'
      - id: tool-plugin-manager
        name: '@deepseek-ai/dsh-plugin-manager/tools'
        disabled: true
      - id: tool-plugin-market
        name: '@deepseek-ai/dsh-plugin-market/tools'
        disabled: true
`;

function renderPatch(board, slug, name, description, persona) {
  const head = [
    '# 本文件由 AgentFlow 自动生成，请勿手改 —— 重新生成会整体覆盖。',
    `# 来源画布：《${name}》${board?.id ? `（id: ${flat(board.id)}）` : ''}`,
    '# 生成器：~/.dsh/agent-flow/preset-gen.mjs',
    '# 注意：delegation 组里的 tool-subagent 是分层下发子 agent 的唯一途径，不要删。',
    '',
    `- id: preset-flow-${slug}`,
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    `    id: flow-${slug}`,
    `    name: ${yamlString(name)}`,
    `    description: ${yamlString(description)}`,
    '    order: 50',
    '    plugins:',
    '      - id: persona',
    "        name: '@deepseek-ai/dsh-persona'",
    '        config:',
    '          prefix: |-',
  ].join('\n');

  // 块标量内容统一缩进 12 空格（prefix 键再深一层）；空行留空即可
  const personaYaml = persona
    .split('\n')
    .map((line) => (line ? `            ${line}` : ''))
    .join('\n');

  const rawPatch = `${head}\n${personaYaml}\n${PLUGIN_REST}`;
  // bundle patch 的顶层必须是条目数组；这一条是「新增一行」，所以要包进 insert。
  // 直接写 - id: 会被当成「覆写一个已存在的 id」，而那个 id 根本不存在 → 整行被忽略。
  const marker = `- id: preset-flow-${slug}`;
  const at = rawPatch.indexOf(marker);
  if (at < 0) return rawPatch;
  const before = rawPatch.slice(0, at);
  const body = rawPatch
    .slice(at)
    .split('\n')
    .map((line) => (line ? '  ' + line : line))
    .join('\n');
  return `${before}- insert:\n${body}`;
}

function renderReadme({ slug, name, nodeCount, layerCount, packageName }) {
  return `# ${packageName}

由 **AgentFlow 画布《${name}》** 编译生成的 DSH agent preset 组合包。

## 这个预设干什么

新会话选预设「${name}」后：

1. 主 agent 先和你对齐需求（最多问 3 个问题、一次问完）；
2. 再按画布结构（${nodeCount} 个节点 / ${layerCount} 层）用 \`subagent\` 工具分层下发子 agent；
3. 同层并行，上游产出原样传给下游，最后汇总交付。

本包只新增 \`preset-flow-${slug}\`，不覆写官方 standard。

## 安装

默认 profile：\`~/.dsh/profiles/desktop\`。

1. 把本目录加进 profile 的 \`dependencies\` 并建软链（把 \`<本目录>\` 换成绝对路径）：

   \`\`\`sh
   cd ~/.dsh/profiles/desktop
   node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies['${packageName}']='link:<本目录>';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+String.fromCharCode(10))"
   ln -sfn <本目录> node_modules/${packageName}
   \`\`\`

2. 在 profile 的 \`cordis.patch.yml\` 末尾插入：

   \`\`\`yaml
   - insert:
       - id: preset-flow-${slug}
         name: '${packageName}'
   \`\`\`

3. 重启 DSH，新建会话时在预设列表里选「${name}」。

AgentFlow 导出接口会连绝对路径一起给出可以直接粘贴的命令；这里只写通用步骤。

## 卸载

1. 删掉 profile \`cordis.patch.yml\` 里上面那条 \`insert\`；
2. 从 \`dependencies\` 删掉 \`${packageName}\`；
3. \`rm -f node_modules/${packageName}\`；
4. 重启 DSH。

## 重新生成

本目录由 \`~/.dsh/agent-flow/preset-gen.mjs\` 生成，重新导出会整体覆盖，别手改。
`;
}

/**
 * 生成 bundle 的三个文件内容（不落盘）。
 * @returns {{packageJson: string, patch: string, readme: string}}
 */
export function buildPresetFiles(board, slug, opts = {}) {
  const safeSlug = normalizeSlug(slug) || slugify(board?.name, 'flow');
  // 显示名允许自定义；presetId 仍由 slug（画布名）决定，避免改名后预设 id 漂移
  const name = flat(opts.name) || flat(board?.name) || '未命名画布';
  const layers = topoLayers(board);
  const nodeCount = layers.reduce((sum, layer) => sum + layer.nodes.length, 0);
  const description = `由 AgentFlow 画布《${name}》生成：${nodeCount} 个节点 / ${layers.length} 层`;
  const packageName = `dsh-plugin-flow-${safeSlug}`;

  const packageJson = `${JSON.stringify(
    {
      name: packageName,
      version: '0.1.0',
      type: 'module',
      private: true,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    null,
    2,
  )}\n`;

  const patch = renderPatch(board, safeSlug, name, description, renderPersona(board));
  const readme = renderReadme({ slug: safeSlug, name, nodeCount, layerCount: layers.length, packageName });

  return { packageJson, patch, readme };
}

/**
 * 把 bundle 写进 dir（目录不存在会建；存在则覆盖同名文件）。
 * @returns {Promise<{dir: string, files: string[]}>}
 */
/** 集成标记：插件 patch 里被包裹的这段由 AgentFlow 生成，重新导出会整体替换 */
const PRESET_BLOCK_START = '# >>> AgentFlow 预设（自动生成，重新导出会整体替换这段）';
const PRESET_BLOCK_END = '# <<< AgentFlow 预设结束';

/**
 * 把画布编译的预设写进 profile 的 cordis.patch.yml。
 *
 * 为什么不写进插件包：只有 profile `dsh.profile.bundles` 里的包，其 bundle patch
 * 才会被展开；dsh-plugin-agentflow 是以 host 行（- insert: id: agentflow）挂的，
 * 写进它的 patch 不会生效。所以预设段落落在 profile patch 里，用标记包裹，
 * 重新导出整段替换，profile 里其它行保持原样。
 *
 * @param {object} board
 * @param {{patchFile: string}} opts profile 的 cordis.patch.yml 路径
 * @returns {Promise<{file: string, presetId: string, name: string, replaced: boolean}>}
 */
export async function installPresetIntoProfile(board, opts = {}) {
  const patchFile = typeof opts.patchFile === 'string' && opts.patchFile.trim();
  if (!patchFile) throw new Error('installPresetIntoProfile 需要 patchFile');
  const slug = slugify(board?.name, board?.id ? `flow-${board.id}` : 'flow');
  const name = String(opts.name || '').trim() || String(board?.name || board?.id || 'AgentFlow');
  const { patch } = buildPresetFiles(board, slug, { name });

  const exists = await stat(patchFile).then((s) => s.isFile()).catch(() => false);
  if (!exists) throw new Error(`找不到 profile patch：${patchFile}`);
  const current = await readFile(patchFile, 'utf8');
  const replaced = current.includes(PRESET_BLOCK_START);
  const head = current.split(PRESET_BLOCK_START)[0].trimEnd();
  const block = `${PRESET_BLOCK_START}\n${patch.trimEnd()}\n${PRESET_BLOCK_END}`;
  await writeFile(patchFile, `${head}\n\n${block}\n`, 'utf8');
  return { file: patchFile, presetId: `flow-${slug}`, name, replaced };
}

/** 兼容旧名字：集成目标已从插件包改为 profile patch */
export const installPresetIntoPlugin = installPresetIntoProfile;

export async function writePresetBundle(board, dir) {
  if (typeof dir !== 'string' || !dir.trim()) {
    throw new Error('writePresetBundle 需要一个目标目录');
  }
  const target = path.resolve(dir);
  const slug = slugify(board?.name, board?.id ? `flow-${board.id}` : 'flow');
  const { packageJson, patch, readme } = buildPresetFiles(board, slug);

  const entries = [
    ['package.json', packageJson],
    ['cordis.patch.yml', patch],
    ['README.md', readme],
  ];
  await mkdir(target, { recursive: true });
  await Promise.all(entries.map(([file, content]) => writeFile(path.join(target, file), content, 'utf8')));

  return { dir: target, files: entries.map(([file]) => path.join(target, file)) };
}
