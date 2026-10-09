#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量索引存量记忆到向量库。

用法:
    python migrate_to_vector.py <root_path> [--batch-size 100] [--skip-private]
    
示例:
    python migrate_to_vector.py C:/Users/xxxxx/Desktop/Alpha-Memory/data/mdcg/user
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from md_cg.mdcos import MdCGOS
from md_cg.vector_index import VectorIndex
import argparse
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)


def migrate_memory_to_vector(root_path, batch_size=100, skip_private=False):
    """将存量记忆迁移到向量库。
    
    Args:
        root_path: Alpha Memory 根目录
        batch_size: 批量索引大小
        skip_private: 是否跳过 private/secret 敏感度的节点
    
    Returns:
        (total, success, fail, skipped)
    """
    logger.info(f"开始迁移: {root_path}")
    
    # 加载 Alpha Memory
    md = MdCGOS(root=root_path, actor="system")
    total_nodes = len(md.index["nodes"])
    logger.info(f"总计 {total_nodes} 个节点")
    
    # 初始化 VectorIndex
    vi = VectorIndex(root_path)
    
    # 准备批量索引数据
    nodes_to_index = []
    skipped = 0
    
    for nid, node in md.index["nodes"].items():
        content = node.get("content", "")
        sensitivity = node.get("sensitivity", "private")
        
        # 跳过条件
        if not content or not content.strip():
            skipped += 1
            continue
        
        if skip_private and sensitivity in ("private", "secret"):
            skipped += 1
            continue
        
        # ACL 可见性
        acl_visible = sensitivity in ("public", "internal")
        nodes_to_index.append((nid, content, acl_visible, sensitivity))
    
    logger.info(f"待索引 {len(nodes_to_index)} 个节点，跳过 {skipped} 个")
    
    # 批量索引
    success, fail = vi.index_nodes_batch(nodes_to_index, batch_size=batch_size)
    
    # 验证
    info = vi.client.get_collection(vi.collection)
    logger.info(f"索引完成: 成功 {success}, 失败 {fail}")
    logger.info(f"向量库总计: {info.points_count} 个点")
    
    vi.close()
    
    return total_nodes, success, fail, skipped


def main():
    parser = argparse.ArgumentParser(description="批量索引存量记忆到向量库")
    parser.add_argument("root_path", help="Alpha Memory 根目录")
    parser.add_argument("--batch-size", type=int, default=100, help="批量索引大小")
    parser.add_argument("--skip-private", action="store_true", help="跳过 private/secret 节点")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.root_path):
        logger.error(f"路径不存在: {args.root_path}")
        sys.exit(1)
    
    try:
        total, success, fail, skipped = migrate_memory_to_vector(
            args.root_path,
            batch_size=args.batch_size,
            skip_private=args.skip_private
        )
        
        print("\n" + "="*60)
        print("迁移完成！")
        print(f"  总节点数: {total}")
        print(f"  成功索引: {success}")
        print(f"  失败: {fail}")
        print(f"  跳过: {skipped}")
        print("="*60)
        
    except Exception as e:
        logger.error(f"迁移失败: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()