import React from "react";
export const imageUrl = (id) => `/api/post-images/${encodeURIComponent(id)}`;
export default function PostBody({ post }) {
  function pictures(position) {
    return (post.images || [])
      .filter((x) => x.after_step === position)
      .map((x, i) => (
        <figure className="post-photo" key={`${x.id}-${i}`}>
          <img
            src={imageUrl(x.id)}
            alt={x.alt}
            loading="lazy"
            decoding="async"
          />
          {x.caption && <figcaption>{x.caption}</figcaption>}
        </figure>
      ));
  }
  return (
    <div className="post-body">
      {pictures(0)}
      <ol>
        {post.steps.map((s, i) => (
          <li key={i}>
            <span>{i + 1}</span>
            <div className="post-step">
              <p>{s}</p>
              {pictures(i + 1)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
