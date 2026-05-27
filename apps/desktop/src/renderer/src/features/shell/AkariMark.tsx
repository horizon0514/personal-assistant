import mark from "../../assets/akari-mark.svg";

/** 品牌徽标:统一琥珀底深纹,浅/深背景上都跳得出来,不随主题翻转。 */
export function AkariMark({ className, alt = "Akari" }: { className?: string; alt?: string }): JSX.Element {
  return <img src={mark} alt={alt} className={className} />;
}
