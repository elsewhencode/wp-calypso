/**
 * External Dependencies
 */
var assign = require( 'lodash/object/assign' ),
	config = require( 'config' ),
	//debug = require( 'debug' )( 'calypso:lib:comment-store' ),
	isEqual = require( 'lodash/lang/isEqual' ),
	clone = require( 'lodash/lang/clone' ),
	moment = require( 'moment' ),
	findKey = require( 'lodash/object/findKey' ),
	reject = require( 'lodash/collection/reject' );


/**
 * Internal dependencies
 */
var Dispatcher = require( 'dispatcher' ),
	Emitter = require( 'lib/mixins/emitter' ),
	CommentActions = require( './actions' ),
	FeedPostStoreActionTypes = require( 'lib/feed-post-store/constants' ).action,
	key = require( './utils' ).key,
	ActionTypes = require( './constants' ).action,
	States = require( './constants' ).state,
	formatting = require( 'lib/formatting' );

var _commentsForPost = {},
	CommentStore,
	receivedErrors = [],
	commentPlaceholder = {
		ID: 'pending',
		content: '',
		type: 'comment',
		date: moment().toISOString()
	};

/**
 * Get comments for a post
 *
 * @returns {array} Comment objects
 *
 * @param {int} Site ID
 * @param {int} Post ID
 */
function getComments( siteId, postId ) {
	return _commentsForPost[ key( siteId, postId ) ];
}

/**
 * Set the comments for a post
 *
 * @param {int} Site ID
 * @param {int} Post ID
 * @param {array} Comments
 */
function setComments( siteId, postId, comments ) {
	_commentsForPost[ key( siteId, postId ) ] = comments;
}

/**
 * Add a new comment for a post
 *
 * @param {int} Site ID
 * @param {int} Post ID
 * @param {object} Comment
 */
function addComment( siteId, postId, comment ) {
	if ( comment.parent && comment.parent.ID > 0 ) {
		_commentsForPost[ key( siteId, postId ) ].comments.push( comment );
		return;
	}

	_commentsForPost[ key( siteId, postId ) ].comments.unshift( comment );
}

/**
 * Add a new pending comment - one that the user has submitted,
 * but we've not received the API response for yet.
 *
 * @param {int} Site ID
 * @param {int} Post ID
 * @param {string} Comment text
 * @param {int} Parent comment ID
 * @param {string} Temporary placeholder ID for the comment, generated by the action (e.g 'pending1')
 */
function addPendingComment( siteId, postId, commentText, parentCommentId, commentPlaceholderId ) {
	var postComments = getComments( siteId, postId );
	if ( ! postComments ) {
		setComments( siteId, postId, {
			comments: [],
			count: 0
		} );
	}

	// Clear out any existing errors for this siteId and postId
	removeErrorsForPost( siteId, postId );

	// Clean up any error posts that might be hanging around
	removePostsInErrorState( siteId, postId );

	// Create temporary placeholder comment until we hear from the API
	var comment = clone( commentPlaceholder );
	comment.state = States.PENDING;
	comment.ID = commentPlaceholderId;
	comment.content = formatting.stripHTML( commentText );
	comment.parent = { ID: parentCommentId };
	comment.date = moment().toISOString();

	addComment( siteId, postId, comment );

	CommentStore.emit( 'add', comment );
	CommentStore.emit( 'change' );
}

/**
 * Confirm an existing pending comment
 *
 * This happens when we receive a successful API response.
 *
 * @param {int} Site ID
 * @param {int} Post ID
 * @param {string} Temporary placeholder ID for the comment, generated by the action (e.g 'pending1')
 * @param {object} Confirmed comment
 */
function confirmComment( siteId, postId, commentPlaceholderId, confirmedComment ) {

	// Find the pending comment
	var postComments = getComments( siteId, postId ),
		pendingCommentKey = findKey( postComments.comments, { ID: commentPlaceholderId } );

	if ( ! pendingCommentKey ) {
		return;
	}

	// Replace the comment with the new one and set the state to complete
	confirmedComment.state = States.CONFIRMED;

	// If the comment can be published immediately (i.e. doesn't require moderation), increment the comment count
	if ( confirmedComment.status === 'approved' ) {
		postComments.count++;
	}

	// For nested comments, re-insert the comment at the top of the array, so we see it at the top of the thread on the UI
	if ( confirmedComment.parent.ID > 0 ) {
		postComments.comments.splice( pendingCommentKey, 1 );
		postComments.comments.push( confirmedComment );
	} else {
		postComments.comments[ pendingCommentKey ] = confirmedComment;
	}

	setComments( siteId, postId, postComments );

	CommentStore.emit( 'change' );
}

/**
 * Receive an error - store it, and change the pending comment to an error state.
 *
 * This happens when we receive an unsuccessful API response.
 *
 * @param {int} Site ID
 * @param {int} Post ID
 * @param {string} Temporary placeholder ID for the comment, generated by the action (e.g 'pending1')
 * @param {object} Error
 */
function receiveError( siteId, postId, commentPlaceholderId, error ) {
	var receivedErrorsForPost = receivedErrors[ key( siteId, postId ) ];

	if ( ! receivedErrorsForPost ) {
		receivedErrorsForPost = [];
	}

	var postComments = getComments( siteId, postId ),
		pendingCommentKey = findKey( postComments.comments, { ID: commentPlaceholderId } );

	// Add the error to the received errors array
	error.ID = commentPlaceholderId;
	receivedErrorsForPost.push( error );
	receivedErrors[ key( siteId, postId ) ] = receivedErrorsForPost;

	// Change the state of the comment to ERROR
	if ( pendingCommentKey && postComments.comments[ pendingCommentKey ] ) {
		var newPostComments = clone( postComments );
		var errorComment = newPostComments.comments[ pendingCommentKey ];
		errorComment.state = States.ERROR;

		// For replies, re-insert the comment at the top of the array, so we see it at the top of the thread on the UI
		if ( errorComment.parent.ID > 0 ) {
			newPostComments.comments.splice( pendingCommentKey, 1 );
			newPostComments.comments.push( errorComment );
		}

		setComments( siteId, postId, newPostComments );
	}

	CommentStore.emit( 'change' );
}

/**
 * Remove any received errors for a post
 *
 * @param {int} Site ID
 * @param {int} Post ID
 */
function removeErrorsForPost( siteId, postId ) {
	receivedErrors[ key( siteId, postId ) ] = null;
}

/**
 * Remove any posts in the 'ERROR' state
 *
 * @param {int} Site ID
 * @param {int} Post ID
 */
function removePostsInErrorState( siteId, postId ) {
	var postComments = getComments( siteId, postId );
	if ( postComments ) {
		var newPostComments = reject( postComments.comments, { state: States.ERROR } );
		postComments.comments = newPostComments;
		setComments( siteId, postId, postComments );
	}
}

CommentStore = {
	/**
	 * Get a list of comments for a post
	 *
	 * @returns {object} A map of comments keyed by parent comment ID
	 *
	 * @param {int} Site ID
	 * @param {int} Post ID
	 */
	getCommentsForPost: function( siteId, postId ) {

		var comments = getComments( siteId, postId );

		// Do we have comments for this post yet? If not, trigger a fetch
		// @todo Recently we've started doing this in the action instead. Should be moved at some point.
		if ( ! comments || ! comments.comments ) {
			CommentActions.fetch( siteId, postId );
			return null;
		}

		// Return comments keyed by parent comment ID ('0' is top-level)
		// @todo Consider caching comments in this format
		var commentResults = {};

		comments.comments.forEach( function( comment ) {

			var parentCommentId = 0;
			if ( comment.parent && comment.parent.ID ) {
				parentCommentId = comment.parent.ID;
			}

			if ( ! commentResults[ parentCommentId ] ) {
				commentResults[ parentCommentId ] = [];
			}

			commentResults[ parentCommentId ].unshift( comment );
		} );

		return commentResults;
	},

	/**
	 * Get a count of comments for a post
	 *
	 * @returns {int} Count
	 *
	 * @param {int} Site ID
	 * @param {int} Post ID
	 */
	getCommentCountForPost: function( siteId, postId ) {
		var comments = getComments( siteId, postId );

		if ( ! comments || isNaN( comments.count ) ) {
			return 0;
		}

		return comments.count;
	},

	/**
	 * Get received errors for a post
	 *
	 * @returns {array} Errors
	 *
	 * @param {int} Site ID
	 * @param {int} Post ID
	 */
	getErrorsForPost: function( siteId, postId ) {
		return receivedErrors[ key( siteId, postId ) ];
	},

	/**
	 * Receive post comments from the API
	 *
	 * @param {object} Payload action
	 */
	receivePostComments: function( action ) {
		if ( ! action || action.error ) {
			if ( action.error ) {
				receivedErrors.push( action );
			}
			return;
		}

		if ( ! action.siteId || ! action.postId ) {
			return;
		}

		var currentComments = getComments( action.siteId, action.postId ),
			commentCount = 0;

		if ( ! action.data.comments ) {
			return;
		}

		if ( currentComments ) {
			commentCount = currentComments.count;
		}

		// Adapt response to our format
		var receivedComments = {
			count: commentCount,
			comments: action.data.comments
		};

		if ( ! isEqual( receivedComments, currentComments ) ) {
			setComments( action.siteId, action.postId, receivedComments );
			CommentStore.emit( 'change' );
		}
	},

	/**
	 * Collect comment count from the feed post
	 *
	 * @param {object} Payload action
	 */
	receiveFeedPost: function( action ) {
		if ( ! action || action.error ) {
			if ( action.error ) {
				receivedErrors.push( action );
			}
			return;
		}

		var post, currentComments, newCount;

		post = action.data;

		if ( ! post.discussion ) {
			return;
		}

		currentComments = getComments( post.site_ID, post.ID ) || {};
		newCount = post.discussion && post.discussion.comment_count;

		if ( currentComments.count !== newCount ) {
			setComments( post.site_ID, post.ID, {
				count: newCount,
				comments: currentComments.comments
			} );

			CommentStore.emit( 'change' );
		}
	},

	/**
	 * Receive a new comment from the view
	 *
	 * @param {object} Payload action
	 */
	receiveNewComment: function( action ) {
		var args = action.args;
		addPendingComment( args.siteId, args.postId, args.commentText, args.parentCommentId, args.commentPlaceholderId );
	},

	/**
	 * Receive an API response for a new comment
	 *
	 * @param {object} Payload action
	 */
	receiveNewCommentResponse: function( action ) {
		var args = action.args;

		if ( action.error ) {
			receiveError( args.siteId, args.postId, args.commentPlaceholderId, action.error );
			return;
		}

		confirmComment( args.siteId, args.postId, args.commentPlaceholderId, action.data );
	},

};

if ( config( 'env' ) === 'development' ) {
	assign( CommentStore, {
		// These bedlumps are for testing.
		_all: function() {
			return _commentsForPost;
		},
		_reset: function() {
			_commentsForPost = {};
		}
	} );
}

Emitter( CommentStore );

CommentStore.dispatchToken = Dispatcher.register( function( payload ) {
	var action = payload.action;

	if ( ! action ) {
		return;
	}

	switch ( action.type ) {
		case ActionTypes.RECEIVE_POST_COMMENTS:
			CommentStore.receivePostComments( action );
			break;

		case FeedPostStoreActionTypes.RECEIVE_FEED_POST:
			CommentStore.receiveFeedPost( action );
			break;

		case ActionTypes.ADD_COMMENT:
		case ActionTypes.REPLY_TO_COMMENT:
			CommentStore.receiveNewComment( action );
			break;

		case ActionTypes.RECEIVE_ADD_COMMENT:
		case ActionTypes.RECEIVE_REPLY_TO_COMMENT:
			CommentStore.receiveNewCommentResponse( action );
			break;
	}
} );

module.exports = CommentStore;
