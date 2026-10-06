import { createContext, useContext } from "react";
export const Commerce = createContext(null);
export const useCommerce = () => useContext(Commerce);
