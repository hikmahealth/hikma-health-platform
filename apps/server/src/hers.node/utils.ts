import { URL } from "node:url";

/**
 * Constructs a url by joining together url segments into a full url.
 * Depending on the input of the first argument, this can either be a
 * relative, absolute or complete URL (staring with protocol like https)
 * @param paths
 * @returns
 */
export function urlJoin(...paths: string[]) {
  if (paths.length === 0) {
    return "/";
  }

  const [s, ...ps] = paths;

  let fullpath = s ?? "/";
  for (let p of ps) {
    fullpath = fullpath.replace(/(\/+)$/, "");
    fullpath = fullpath + "/" + p.replace(/^(\/)/, "");
  }

  return fullpath;
}

/**
 * Extends the standard URL class to allow chaining of paths
 * using the `joinPath` method.
 */
export class JURL extends URL {
  /**
   * Joins one or more path segments onto the current URL,
   * returning a new ChainableURL instance.
   * @param paths - Path segments to append
   * @returns A new ChainableURL with the joined path
   */
  joinPath(...paths: string[]): JURL {
    const newurl = new JURL(this);
    newurl.pathname = urlJoin(this.pathname, ...paths);
    return newurl;
  }
}
