/** Owner-side stores for School's class definitions and episode evidence. */
import path from "node:path";
import { PATHS } from "../../config.ts";
import { SchoolClassStore } from "../store/school-classes.ts";
import { SchoolEpisodeStore } from "../store/school-episodes.ts";

export const schoolClasses = new SchoolClassStore(path.join(PATHS.data, "school", "classes"));
export const schoolEpisodes = new SchoolEpisodeStore(path.join(PATHS.data, "school", "episodes"));
