/**
 * WordPress dependencies
 */
import {
	createContext,
	useContext,
	useCallback,
	useMemo,
} from '@wordpress/element';
import { useSelect, useDispatch } from '@wordpress/data';
import { parse, __unstableSerializeAndClean } from '@wordpress/blocks';

/**
 * Internal dependencies
 */
import { STORE_NAME } from './name';
import { updateFootnotesFromMeta } from './footnotes';

const EMPTY_ARRAY = [];

const EntityContext = createContext( {} );

/**
 * Context provider component for providing
 * an entity for a specific entity.
 *
 * @param {Object} props          The component's props.
 * @param {string} props.kind     The entity kind.
 * @param {string} props.type     The entity name.
 * @param {number} props.id       The entity ID.
 * @param {*}      props.children The children to wrap.
 *
 * @return {Object} The provided children, wrapped with
 *                   the entity's context provider.
 */
export default function EntityProvider( { kind, type: name, id, children } ) {
	const parent = useContext( EntityContext );
	const childContext = useMemo(
		() => ( {
			...parent,
			[ kind ]: {
				...parent?.[ kind ],
				[ name ]: id,
			},
		} ),
		[ parent, kind, name, id ]
	);
	return (
		<EntityContext.Provider value={ childContext }>
			{ children }
		</EntityContext.Provider>
	);
}

/**
 * Hook that returns the ID for the nearest
 * provided entity of the specified type.
 *
 * @param {string} kind The entity kind.
 * @param {string} name The entity name.
 */
export function useEntityId( kind, name ) {
	const context = useContext( EntityContext );
	return context?.[ kind ]?.[ name ];
}

/**
 * Hook that returns the value and a setter for the
 * specified property of the nearest provided
 * entity of the specified type.
 *
 * @param {string} kind  The entity kind.
 * @param {string} name  The entity name.
 * @param {string} prop  The property name.
 * @param {string} [_id] An entity ID to use instead of the context-provided one.
 *
 * @return {[*, Function, *]} An array where the first item is the
 *                            property value, the second is the
 *                            setter and the third is the full value
 * 							  object from REST API containing more
 * 							  information like `raw`, `rendered` and
 * 							  `protected` props.
 */
export function useEntityProp( kind, name, prop, _id ) {
	const providerId = useEntityId( kind, name );
	const id = _id ?? providerId;

	const { value, fullValue } = useSelect(
		( select ) => {
			const { getEntityRecord, getEditedEntityRecord } =
				select( STORE_NAME );
			const record = getEntityRecord( kind, name, id ); // Trigger resolver.
			const editedRecord = getEditedEntityRecord( kind, name, id );
			return record && editedRecord
				? {
						value: editedRecord[ prop ],
						fullValue: record[ prop ],
				  }
				: {};
		},
		[ kind, name, id, prop ]
	);
	const { editEntityRecord } = useDispatch( STORE_NAME );
	const setValue = useCallback(
		( newValue ) => {
			editEntityRecord( kind, name, id, {
				[ prop ]: newValue,
			} );
		},
		[ editEntityRecord, kind, name, id, prop ]
	);

	return [ value, setValue, fullValue ];
}

const parsedBlocksCache = new WeakMap();

/**
 * Hook that returns block content getters and setters for
 * the nearest provided entity of the specified type.
 *
 * The return value has the shape `[ blocks, onInput, onChange ]`.
 * `onInput` is for block changes that don't create undo levels
 * or dirty the post, non-persistent changes, and `onChange` is for
 * persistent changes. They map directly to the props of a
 * `BlockEditorProvider` and are intended to be used with it,
 * or similar components or hooks.
 *
 * @param {string} kind         The entity kind.
 * @param {string} name         The entity name.
 * @param {Object} options
 * @param {string} [options.id] An entity ID to use instead of the context-provided one.
 *
 * @return {[unknown[], Function, Function]} The block array and setters.
 */
export function useEntityBlockEditor( kind, name, { id: _id } = {} ) {
	const providerId = useEntityId( kind, name );
	const id = _id ?? providerId;
	const { getEntityRecord, getEntityRecordEdits } = useSelect( STORE_NAME );
	const { content, editedBlocks, meta } = useSelect(
		( select ) => {
			if ( ! id ) {
				return {};
			}
			const { getEditedEntityRecord } = select( STORE_NAME );
			const editedRecord = getEditedEntityRecord( kind, name, id );
			return {
				editedBlocks: editedRecord.blocks,
				content: editedRecord.content,
				meta: editedRecord.meta,
			};
		},
		[ kind, name, id ]
	);
	const { __unstableCreateUndoLevel, editEntityRecord } =
		useDispatch( STORE_NAME );

	const blocks = useMemo( () => {
		if ( ! id ) {
			return undefined;
		}

		if ( editedBlocks ) {
			return editedBlocks;
		}

		if ( ! content || typeof content !== 'string' ) {
			return EMPTY_ARRAY;
		}

		// If there's an edit, cache the parsed blocks by the edit.
		// If not, cache by the original enity record.
		const edits = getEntityRecordEdits( kind, name, id );
		const isUnedited = ! edits || ! Object.keys( edits ).length;
		const cackeKey = isUnedited ? getEntityRecord( kind, name, id ) : edits;
		let _blocks = parsedBlocksCache.get( cackeKey );

		if ( ! _blocks ) {
			_blocks = parse( content );
			parsedBlocksCache.set( cackeKey, _blocks );
		}

		return _blocks;
	}, [
		kind,
		name,
		id,
		editedBlocks,
		content,
		getEntityRecord,
		getEntityRecordEdits,
	] );

	const updateFootnotes = useCallback(
		( _blocks ) => updateFootnotesFromMeta( _blocks, meta ),
		[ meta ]
	);

	const onChange = useCallback(
		( newBlocks, options ) => {
			const noChange = blocks === newBlocks;
			if ( noChange ) {
				return __unstableCreateUndoLevel( kind, name, id );
			}
			const { selection, ...rest } = options;

			// We create a new function here on every persistent edit
			// to make sure the edit makes the post dirty and creates
			// a new undo level.
			const edits = {
				selection,
				content: ( { blocks: blocksForSerialization = [] } ) =>
					__unstableSerializeAndClean( blocksForSerialization ),
				...updateFootnotes( newBlocks ),
			};

			editEntityRecord( kind, name, id, edits, {
				isCached: false,
				...rest,
			} );
		},
		[
			kind,
			name,
			id,
			blocks,
			updateFootnotes,
			__unstableCreateUndoLevel,
			editEntityRecord,
		]
	);

	const onInput = useCallback(
		( newBlocks, options ) => {
			const { selection, ...rest } = options;
			const footnotesChanges = updateFootnotes( newBlocks );
			const edits = { selection, ...footnotesChanges };

			editEntityRecord( kind, name, id, edits, {
				isCached: true,
				...rest,
			} );
		},
		[ kind, name, id, updateFootnotes, editEntityRecord ]
	);

	return [ blocks, onInput, onChange ];
}
