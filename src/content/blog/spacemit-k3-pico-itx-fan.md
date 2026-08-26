---
showHeroImage: false
comments: true
sidebar:
  enable: true
  toc: true
  relatedPosts: true
title: K3 Pico-ITX 风扇策略与配置指南
publicationStatus: published
draft: false
description: K3 Pico-ITX 默认由 Linux 根据 CPU 温度自动调节风扇，控制链如下：
date: 2026-08-26T11:40:00+08:00
tags: []
categories: []
series: []
updatedDate: 2026-08-26T13:44:52+08:00
---

# K3 Pico-ITX 风扇策略与配置指南

## 📌 工作原理与重要提示

K3 Pico-ITX 默认由 Linux 根据 CPU 温度自动调节风扇，控制链如下：

```text
thermal_cluster0 (step_wise)
  -> pwm-fan cooling device
  -> EC PWM channel 0
  -> 风扇
```

日常使用不需要手动设置。临时调试时，可以通过 sysfs 设置 PWM 档位，也可以
通过 `ectool` 设置目标转速或固定占空比。

> ⚠️ 手动控制前必须暂停 Linux 自动温控，结束后必须恢复。否则 Linux 和
> `ectool` 可能同时修改同一个风扇，引发控制冲突。

当前最低运行档为 30/255，约 12%，且没有配置启动 boost。低占空比可能使
部分风扇无法可靠起转。`thermal_cluster0` 没有 critical trip，不能将它当作
过热关机保护。

## 当前自动温控策略

### 风扇档位映射表

`cooling state` 是 Linux thermal framework 使用的风扇档位。每个 state 对应
`cooling-levels` 中的一个 PWM 值。

| cooling state | PWM 值 | 约占满量程 |
| ------------- | ----- | ----- |
| 0             | 0     | 0%    |
| 1             | 30    | 12%   |
| 2             | 60    | 24%   |
| 3             | 90    | 35%   |
| 4             | 120   | 47%   |
| 5             | 149   | 58%   |
| 6             | 170   | 67%   |
| 7             | 191   | 75%   |
| 8             | 213   | 84%   |

### 温度触发点（Trips）

| 温度   | 类型      | 该温度点允许的 state |
| ---- | ------- | ------------- |
| 45°C | active  | 0..1          |
| 55°C | passive | 2..3          |
| 65°C | passive | 3..4          |
| 75°C | passive | 4             |
| 78°C | passive | 5             |
| 82°C | passive | 6             |
| 85°C | passive | 7             |
| 88°C | passive | 8             |

所有温度点的滞回（hysteresis）均为 2°C。`step_wise` governor 会根据当前
温度、温度变化趋势以及 cooling map 允许的范围逐级升降档，并不保证越过
温度点后立即跳到表中的最高档。普通轮询周期为 1 秒，处理 passive trip 时
缩短为 0.5 秒。

## 用户指南：查看与临时配置

### 1. 动态查找 sysfs 节点

sysfs 编号取决于驱动加载顺序，不能写死 `thermal_zone3`、`hwmon8` 或
`cooling_device1`。下面的脚本会按节点名称查找本机实际路径，并保存到变量中：

```sh
TZ=
for z in /sys/class/thermal/thermal_zone*; do
    [ "$(cat "$z/type" 2>/dev/null)" = "thermal_cluster0" ] && TZ=$z && break
done

CDEV=
for c in /sys/class/thermal/cooling_device*; do
    [ "$(cat "$c/type" 2>/dev/null)" = "pwm-fan" ] && CDEV=$c && break
done

PWM_HWMON=
EC_HWMON=
for h in /sys/class/hwmon/hwmon*; do
    case "$(cat "$h/name" 2>/dev/null)" in
        pwmfan)  PWM_HWMON=$h ;;
        cros_ec) EC_HWMON=$h ;;
    esac
done

[ -n "$TZ" ] && [ -n "$CDEV" ] && [ -n "$PWM_HWMON" ] || {
    echo "错误：未找到风扇相关的 thermal/sysfs 节点"
    exit 1
}

echo "节点查找成功："
echo "TZ=$TZ"
echo "CDEV=$CDEV"
echo "PWM_HWMON=$PWM_HWMON"
echo "EC_HWMON=$EC_HWMON"
```

变量含义：

* `TZ`：CPU thermal zone，用于读取温度以及启停 Linux 自动温控。
* `CDEV`：`pwm-fan` cooling device，用于读取和设置 cooling state。
* `PWM_HWMON`：`pwm-fan` hwmon 节点，用于直接读写 0..255 的 PWM 值。
* `EC_HWMON`：EC hwmon 节点，用于读取实际 RPM 和故障状态；某些系统可能
  不提供该节点。

### 2. 状态只读检查

查看 thermal zone 的类型、调速策略和启用状态：

```sh
echo "类型=$(cat "$TZ/type") 策略=$(cat "$TZ/policy") 模式=$(cat "$TZ/mode")"
```

查看当前温度。单位为毫摄氏度，例如 `55000` 表示 55°C：

```sh
echo "当前温度=$(cat "$TZ/temp")"
```

查看当前 cooling state 和最大 state：

```sh
echo "档位=$(cat "$CDEV/cur_state") / 最大档位=$(cat "$CDEV/max_state")"
```

查看当前写入风扇控制器的 PWM 值，范围为 0..255：

```sh
echo "当前PWM=$(cat "$PWM_HWMON/pwm1")"
```

查看风扇测速计返回的实际转速：

```sh
echo "实际转速：$(cat "$EC_HWMON/fan1_input") RPM"
```

查看 EC 报告的风扇故障状态，`0` 表示正常，`1` 表示风扇停转或测速异常：

```sh
echo "故障状态=$(cat "$EC_HWMON/fan1_fault")"
```

如果读取 `fan1_input` 返回 `No data available`，通常表示风扇已停转或当前没有
有效测速数据，应结合 `fan1_fault` 判断。`pwm1_enable` 不是 Linux 自动/手动
开关，请勿修改它。

### 3. 使用 sysfs 临时手动设置

第一步，保存当前档位并暂停 Linux 自动温控：

```sh
OLD_STATE=$(cat "$CDEV/cur_state")
echo disabled > "$TZ/mode"
```

`OLD_STATE` 用于测试结束后恢复原档位。`mode=disabled` 会停止该 thermal zone
的自动调节。

> ⚠️ `mode=disabled` 期间系统失去自动散热能力，必须持续观察温度和实际 RPM，
> 不要长时间无人值守。

第二步，使用以下两种方法之一设置风扇。

方法 A：直接写入 0..255 的 PWM 值。下面的命令设置为 120/255，占空比约 47%，
但不代表风扇转速为最大转速的 47%：

```sh
echo 120 > "$PWM_HWMON/pwm1"
```

方法 B：写入目标 cooling state。下面的命令选择 state 6，驱动会查询
`cooling-levels`，并输出该档对应的 PWM 值：

```sh
echo 6 > "$CDEV/cur_state"
```

不建议使用 state 0 或 PWM 0 进行常规测试，以免风扇停止。

第三步，测试完成后立即恢复 Linux 自动温控：

```sh
MAX_STATE=$(cat "$CDEV/max_state")
if [ "$OLD_STATE" = "$MAX_STATE" ]; then
    KICK_STATE=$((MAX_STATE - 1))
else
    KICK_STATE=$MAX_STATE
fi

echo "$KICK_STATE" > "$CDEV/cur_state"
echo "$OLD_STATE" > "$CDEV/cur_state"
echo enabled > "$TZ/mode"
```

先写 `KICK_STATE`，再写 `OLD_STATE`，可确保手动写入的 PWM 被档位值覆盖；如果
直接再次写入当前 state，`pwm-fan` 可能不会刷新底层输出。最后写入
`mode=enabled`，将控制权交还给 Linux。

恢复后应重新执行上一节的只读命令，确认 `mode=enabled`、策略为
`step_wise`、实际 RPM 正常且 `fan1_fault=0`。

## 用户指南：通过 ectool 配置

使用前应先按 sysfs 小节找到节点、保存 `OLD_STATE`，再暂停 Linux 自动温控：

```sh
OLD_STATE=$(cat "$CDEV/cur_state")
echo disabled > "$TZ/mode"
```

这两条命令分别保存当前档位和停止 Linux 自动调速，避免 Linux 与 `ectool`
争抢风扇控制权。

| 命令                          | 功能                                | 注意事项                        |
| --------------------------- | --------------------------------- | --------------------------- |
| `ectool version`            | 查看 EC 固件版本和当前运行镜像                 | 只读，可用于确认 `ectool` 与 EC 通信正常 |
| `ectool pwmgetnumfans`      | 查询 EC 识别到的风扇数量                    | 只读，用于确认风扇通道是否存在             |
| `ectool pwmgetfanrpm all`   | 读取所有风扇的实际 RPM                     | 只读，设置后应使用该命令确认实际转速          |
| `ectool pwmsetfanrpm 2000`  | 请求 EC 将风扇稳定在 2000 RPM             | 属于目标转速闭环控制，实际 RPM 仍需读取确认    |
| `ectool fanduty 50`         | 将风扇固定为 50% 占空比                    | 属于开环控制，50% 占空比不等于 50% 转速    |
| `ectool pwmsetduty 0 32768` | 将 generic PWM channel 0 设置为约 50%  | 参数为 16 位值，范围是 0..65535      |
| `ectool pwmgetduty 0`       | 读取 generic PWM channel 0 的 16 位设置 | 读取的是设置值，不是实际 RPM            |
| `ectool autofanctrl`        | 恢复 EC 自身的自动风扇控制                   | 这不是恢复 Linux DTS 自动温控策略      |

每次只测试一种写入方式。设置后使用 `ectool pwmgetfanrpm all` 读取实际 RPM，
并通过 sysfs 的 `fan1_fault` 检查故障状态。

测试结束后，即使已经执行 `ectool autofanctrl`，也必须执行 sysfs 小节中的
`KICK_STATE -> OLD_STATE -> mode=enabled` 恢复流程，将控制权交还给 Linux。

## 开发者指南：修改 DTS

核心设备树配置如下。示例只展示前两个 trip 和 cooling map，其余温度点使用
相同结构继续定义：

```dts
fan0: pwm-fan {
    compatible = "pwm-fan";
    pwms = <&cros_ec_pwm 0>;
    cooling-levels = <0 30 60 90 120 149 170 191 213>;
    #cooling-cells = <2>;
};

thermal_cluster0 {
    polling-delay = <1000>;
    polling-delay-passive = <500>;
    thermal-sensors = <&thermal 4>;

    trips {
        trip0: trip0 {
            temperature = <45000>;
            hysteresis = <2000>;
            type = "active";
        };

        trip1: trip1 {
            temperature = <55000>;
            hysteresis = <2000>;
            type = "passive";
        };
    };

    cooling-maps {
        map0 {
            trip = <&trip0>;
            cooling-device = <&fan0 0 1>;
        };

        map1 {
            trip = <&trip1>;
            cooling-device = <&fan0 2 3>;
        };
    };
};
```

### DTS 属性修改的含义

| 属性                             | 修改效果                               | 注意事项                                |
| ------------------------------ | ---------------------------------- | ----------------------------------- |
| `pwms = <&cros_ec_pwm 0>`      | 选择 EC PWM 控制器的 channel 0           | 改错 channel 可能无法控制风扇，或误控其他 PWM 设备    |
| `cooling-levels`               | 定义 cooling state 到 0..255 PWM 值的映射 | 提高某项会增加该档风量、噪声和功耗；降低则相反             |
| `#cooling-cells = <2>`         | 允许 cooling map 传入最低和最高 state       | `pwm-fan` 需要保持为 2                   |
| `temperature`                  | 设置 trip 的触发温度，单位为毫摄氏度              | 调低会更早加强散热；调高会延后散热并增加温度风险            |
| `hysteresis`                   | 设置温度下降到触发点以下多少才退出该 trip，单位为毫摄氏度    | 增大可减少频繁升降档，但风扇也会更晚降档                |
| `type = "active"`              | 表示该 trip 主要通过风扇等主动散热设备处理           | 通常用于较低温度的风扇启动阶段                     |
| `type = "passive"`             | 进入 passive thermal 控制阶段            | 会使用 `polling-delay-passive` 指定的轮询周期 |
| `cooling-device = <&fan0 L U>` | 将该 trip 可使用的风扇档位限制在 state `L..U`   | 修改上下界会改变该温度点允许的最低和最高档位              |
| `polling-delay`                | 设置普通状态下的温度检查间隔，单位为毫秒               | 越短响应越快，但轮询更频繁                       |
| `polling-delay-passive`        | 设置 passive 状态下的温度检查间隔，单位为毫秒        | 影响高温阶段的响应速度                         |

修改 `cooling-levels` 会改变每个档位的实际输出，修改 trip 温度会改变升降档
时机，修改 cooling map 则会改变各温度区间允许使用的档位。这三部分应一起
评估，不能只修改其中一项后假定其他行为不变。

## 启动 Boost

提高 `cooling-levels` 的首个非零值可以改善低档起转能力，但会增加低温时的
底噪和功耗。更合适的做法是在 `pwm-fan` 节点配置从停止到启动时的 boost：

```dts
fan-stop-to-start-percent = <40>; /* 启动时使用 40% 占空比 */
fan-stop-to-start-us = <3000000>; /* 保持 3 秒 */
```

`fan-stop-to-start-percent` 设置启动占空比，`fan-stop-to-start-us` 设置保持时间，
单位为微秒。它们只在风扇从完全停止状态启动时生效。以上数值只是配置示例，
必须经过真机冷启动、热启动和反复启停验证后才能确定。

## 🛡️ 安全检查清单

* \[ ] 手动控制期间持续观察温度、RPM 和 `fan1_fault`，不要长时间无人值守。
* \[ ] sysfs 和 `ectool` 操作的是同一个物理风扇，不要同时发出控制命令。
* \[ ] 修改 DTS 后验证冷启动、热启动、反复升降档、温度滞回、系统挂起/恢复
  以及关机。
* \[ ] 不使用长时间停止风扇或写 PWM 0 的方式进行常规压力测试。

## 源码位置参考

* `arch/riscv/boot/dts/spacemit/k3-pico.dtsi`：风扇档位、trip 和 cooling map。
* `drivers/hwmon/pwm-fan.c`：处理 cooling state、sysfs、启动 boost 和电源管理。
* `drivers/pwm/pwm-cros-ec.c`：负责 Linux PWM 到 EC PWM 协议的转换。
* `drivers/thermal/gov_step_wise.c`：`step_wise` 调档核心逻辑。
