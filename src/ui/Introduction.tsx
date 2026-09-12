import { useEffect, useRef } from "react";
import { ArrowRight, Languages } from "lucide-react";
import type { Language } from "../shared/types";
import { text } from "./i18n";

export function Introduction({
  language,
  onLanguageChange,
  onDismiss,
}: {
  language: Language;
  onLanguageChange: () => void;
  onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tx = (zh: string, en: string) => text(language, zh, en);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="intro-dialog"
      aria-labelledby="intro-title"
      aria-describedby="intro-description"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    >
      <div className="intro-topline">
        <span>FUTURE / TRANSIT</span>
        <button type="button" onClick={onLanguageChange}>
          <Languages size={14} />
          {language === "zh" ? "EN" : "中文"}
        </button>
      </div>
      <p className="intro-eyebrow">
        {tx("一个关于未来交通的沙盒", "A sandbox for a different kind of transit")}
      </p>
      <h1 id="intro-title">
        {tx("如果城市交通，能从楼到楼？", "What if transit went building to building?")}
      </h1>
      <p id="intro-description" className="intro-description">
        {tx(
          "这不是汽车模拟器，也不是地铁线路游戏。Pod 是共享的小型无人舱，只在受控的专用轨道上行驶。系统自动派车接人，把乘客送到目的楼的平台，再去接下一个人。",
          "Not a driving simulator or a metro line builder. Pods are small, shared autonomous cabins on a controlled, dedicated network. The system sends a Pod to collect a passenger, delivers them to their destination building’s platform, then serves the next trip.",
        )}
      </p>
      <div className="intro-journey" aria-hidden="true">
        <div className="intro-stop">
          <span className="intro-building intro-home"><i /><i /><i /><i /></span>
          <span>{tx("家门口的平台", "Home platform")}</span>
        </div>
        <div className="intro-connection">
          <span className="intro-pod"><i /></span>
          <span>{tx("同一个 Pod · 无需换乘", "One Pod · no transfers")}</span>
        </div>
        <div className="intro-stop">
          <span className="intro-building intro-office"><i /><i /><i /><i /></span>
          <span>{tx("目的楼的平台", "Destination platform")}</span>
        </div>
      </div>
      <div className="intro-principles">
        <div>
          <span>01</span>
          <h2>{tx("每个人都有去处", "Every person has a destination")}</h2>
          <p>{tx("上班、购物、拜访朋友。点击建筑，看看谁想去哪。", "Work, shopping, visiting friends. Select a building to see who is going where.")}</p>
        </div>
        <div>
          <span>02</span>
          <h2>{tx("你设计网络，不指挥车辆", "Design the network, not each trip")}</h2>
          <p>{tx("铺轨道、建平台、安排停车位。接谁、怎么走，交给自动调度。", "Build tracks, platforms and parking. Automatic dispatch decides whom to collect and how to get there.")}</p>
        </div>
        <div>
          <span>03</span>
          <h2>{tx("城市长大，设计也要长大", "Let your network grow with the city")}</h2>
          <p>{tx("从步行到坐 Pod，从第一次接送到繁忙主干。观察等待，慢慢改好它。", "From walking to the first Pod ride, then busy corridors. Watch the queues and keep improving.")}</p>
        </div>
      </div>
      <p className="intro-footnote">
        {tx(
          "这是一个探索中的早期版本：先做地面网络，未来再探索编组和立体交通。没有失败倒计时，随时可以暂停、拆除、改造。",
          "An early experiment: ground-level networks first; coupling and multi-level transit are for the future. No failure countdown. Pause, rebuild and take your time.",
        )}
      </p>
      <div className="intro-bottomline">
        <small>{tx("建议用电脑游玩 · 进度保存在当前浏览器", "Best on desktop · progress stays in this browser")}</small>
        <button className="intro-start" type="button" autoFocus onClick={onDismiss}>
          {tx("开始规划", "Start planning")}<ArrowRight size={16} />
        </button>
      </div>
    </dialog>
  );
}
