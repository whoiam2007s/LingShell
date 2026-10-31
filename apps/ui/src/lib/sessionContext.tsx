import { createContext, useContext, useState, type ReactNode } from 'react'

// 极简的当前会话 id 共享：App.setActiveId 写入，AuthDrawer 读取（授权以会话为主体）。
// 会话区和授权抽屉是分开的组件树，授权抽屉需要 sessionId，故提升到 Provider 共享。
const Ctx = createContext<{ sessionId: string; setSessionId: (id: string) => void }>({
  sessionId: '',
  setSessionId: () => {},
})

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState('')
  return <Ctx.Provider value={{ sessionId, setSessionId }}>{children}</Ctx.Provider>
}

export const useSession = () => useContext(Ctx)
