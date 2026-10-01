import React from "react";
import Lesson from "./Lesson";
export const imageUrl = (id) => `/api/post-images/${encodeURIComponent(id)}`;
export default function PostBody({ post }) {
  return <Lesson post={post} preview />;
}
