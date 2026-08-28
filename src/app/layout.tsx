import type { Metadata } from "next";
import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";
export const metadata:Metadata={title:"Pax Local — 2020 세계 지도",description:"PC용 2020 OTL 플레이 국가 선택 지도"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ko"><body>{children}</body></html>}
