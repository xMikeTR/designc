import React from 'react';

export default class OldTags extends React.Component {
  render() {
    return (
      <form>
        <input name="tag" placeholder="Tag name" />
        <input type="submit" value="Add tag" />
      </form>
    );
  }
}
