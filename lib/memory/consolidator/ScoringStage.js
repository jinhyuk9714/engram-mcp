import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA } from "./constants.js";

export class ScoringStage {
  constructor({
    query = queryWithAgentVector,
    schema = SCHEMA
  } = {}) {
    this.query = query;
    this.schema = schema;
  }

  async run() {
    return {
      utilityUpdated: await this._updateUtilityScores(),
      anchorsPromoted: await this._promoteAnchors()
    };
  }

  async _updateUtilityScores() {
    const result = await this.query(
      "system",
      `UPDATE ${this.schema}.fragments
       SET utility_score = importance * (1.0 + LN(GREATEST(access_count, 1)))
       WHERE utility_score IS DISTINCT FROM
             importance * (1.0 + LN(GREATEST(access_count, 1)))`,
      [],
      "write"
    );

    return result.rowCount;
  }

  async _promoteAnchors() {
    const result = await this.query(
      "system",
      `UPDATE ${this.schema}.fragments
       SET is_anchor = TRUE
       WHERE is_anchor = FALSE
         AND access_count >= 10
         AND importance >= 0.8`,
      [],
      "write"
    );

    return result.rowCount;
  }
}
